const sh = require('shelljs');
const path = require('path');
const depcruise = require('dependency-cruiser').cruise;
const { Project } = require('ts-morph');
const fs = require('fs-extra');
const depcheck = require('depcheck');

const { getProjectId } = require('./firebaseProject');
const { getTriggers } = require('./triggers');
const { loadJSON, saveJSON } = require('./utility');

function copyPackageJSON(functionsDir) {
  sh.cp(`${path.resolve(functionsDir, 'package.json')}`, path.resolve(functionsDir, 'package-archive.json'));
  sh.mv(path.resolve(functionsDir, 'package.json'), path.resolve(functionsDir, 'package-updated.json'));
  sh.mv(path.resolve(functionsDir, 'package-archive.json'), path.resolve(functionsDir, 'package.json'));
}

function buildProject(functionsDir) {
  const { stderr, code } = sh.exec(`cd '${functionsDir}' && npm run build`);
  if (code !== 0) {
    throw new Error(`Exit code ${code}: ${stderr}`);
  }
}

function createSubproject(rootDir, functionsDir, entryPoint) {
  const subprojectRootDir = path.resolve(rootDir, '.foundry', `${entryPoint}-subproject`);
  const subprojectFunctionsDir = path.resolve(subprojectRootDir, 'functions');

  const movedSubprojectRootDir = path.resolve(functionsDir, '.foundry', `${entryPoint}-subproject`);
  const movedSubprojectFunctionsDir = path.resolve(movedSubprojectRootDir, 'functions');

  sh.mkdir('-p', subprojectFunctionsDir);
  sh.exec(`rsync -a --exclude 'node_modules' '${functionsDir}/' '${subprojectFunctionsDir}/'`);

  const firebasercSource = path.resolve(rootDir, '.firebaserc');
  const firebasercTarget = path.resolve(subprojectRootDir, '.firebaserc');
  const firebaseJSONSource = path.resolve(rootDir, 'firebase.json');
  const firebaseJSONTarget = path.resolve(subprojectRootDir, 'firebase.json');

  const firebaseJSON = loadJSON(firebaseJSONSource);

  if (firebaseJSON.functions) {
    firebaseJSON.functions.predeploy = [];
  }

  saveJSON(firebaseJSONTarget, firebaseJSON);

  sh.cp(firebasercSource, firebasercTarget);
  sh.exec(`echo "lib\nsrc" > ${subprojectFunctionsDir}/.prettierignore`);

  return {
    rootDir: subprojectRootDir,
    funcionsDir: subprojectFunctionsDir,
    movedRootDir: movedSubprojectRootDir,
    movedFunctionsDir: movedSubprojectFunctionsDir,
  };
}

async function prunePackages(rootDir, packageJSON) {
  const unused = await depcheck(rootDir, {});
  const totalDevDependencies = packageJSON.devDependencies ? Object.keys(packageJSON.devDependencies).length : 0;
  const totalDependencies = Object.keys(packageJSON.dependencies).length;
  const prunedDependencies = Object
    .keys(packageJSON.dependencies)
    .filter((name) => {
      const isUnused = unused.dependencies.includes(name);
      return !isUnused;
    }).reduce((dependencies, name) => {
      return {
        ...dependencies,
        [name]: packageJSON.dependencies[name],
      };
    }, {});

  const totalPrunedDependencies = Object.keys(prunedDependencies).length;

  console.debug('Dependencies removed:', totalDevDependencies + (totalDependencies - totalPrunedDependencies), '/', totalDependencies + totalDevDependencies);
  return {
    ...packageJSON,
    dependencies: prunedDependencies,
    devDependencies: {},
  };
}

function removeUnusedFiles(functionsDir) {
  const { totalFiles } = sh.exec(`find '${functionsDir}/src//.' ! -name . -print | grep -c //`, { silent: true })
  const indexPath = path.resolve(functionsDir, 'src', 'index.ts');
  const output = depcruise([path.resolve(functionsDir, 'src')], {
    exclude: '(node_modules)',
    tsPreCompilationDeps: true,
    validate: true,
    ruleSet: {
      forbidden: [{
        name: 'no-unreachable-from-root',
        severity: 'error',
        comment:
          'This dependency is unreachable from the root of your project',
        from: {
          path: 'src/index.ts'
        },
        to: {
          path: 'src',
          pathNot: 'node_modules|\\.(spec)\\.(js|jsx|ts|tsx)',
          reachable: false
        },
      }],
    },
  }).output;

  let removed = 0;

  output.modules.forEach((mod) => {
    if (mod.coreModule) {
      return;
    }
    const modPath = path.resolve(mod.source);
    const isOrphan = mod.orphan;
    const isRoot = modPath === indexPath;
    const isReachable = mod.reachable && mod.reachable.every((r) => r.value);

    if (!isRoot && (isOrphan || !isReachable)) {
      fs.removeSync(modPath);
      removed++;
    }
  });
  console.debug('Unreachable files removed:', removed);
}

function isolateEntryPoint(functionsDir, entryPoint) {
  const indexPath = path.resolve(functionsDir, 'src', 'index.ts');

  const project = new Project({ tsConfigFilePath: path.resolve(functionsDir, 'tsconfig.json') });


  project.getSourceFile(indexPath).getVariableStatements().forEach(statement => {
    statement.setIsExported(false);
  });

  project.getSourceFile(indexPath).getExportDeclarations().forEach(node => {
    node.remove();
  });

  project.getSourceFile(indexPath).getFunctions().forEach(fn => {
    if (fn.getName() !== entryPoint) {
      fn.setIsExported(false);
    }
  });

  const entryPointStatement = project.getSourceFile(indexPath).getVariableStatement(entryPoint);
  if (entryPointStatement) {
    entryPointStatement.setIsExported(true);
  }

  const entryPointFunctions = project.getSourceFile(indexPath).getFunction(entryPoint);
  if (entryPointFunctions) {
    entryPointFunctions.setIsExported(true);
  }

  const i = 10;
  for (let index = 0; index < i; index++) {
    project.getSourceFile(indexPath)
      .fixMissingImports()
      .organizeImports()
      .fixUnusedIdentifiers()
      .fixMissingImports()
      .formatText();
  }

  project.saveSync();
}

function addBundler(packageJSON) {
  return packageJSON
}

function deploySubproject(functionsDir, entryPoint, projectId, debug) {
  const { stderr, code } = sh.exec(`cd '${functionsDir}' && firebase deploy ${debug ? '--debug' : ''} --project ${projectId} --only functions:${entryPoint}`);
  if (code !== 0) {
    throw new Error(`Exit code ${code}: ${stderr}`);
  }
  return {
    timestamp: new Date().getTime(),
  };
}

async function deploy(rootDir, functions, debug) {
  console.log('Initializing...');
  console.time('Initializing...');
  const functionsDir = path.resolve(rootDir, 'functions');

  if (!fs.existsSync(functionsDir)) {
    console.error('Cannot find "functions" directory');
    process.exit(1);
  }

  let projectId;
  try {
    projectId = getProjectId(rootDir);
  } catch (error) {
    console.error('No active Firebase project. Use "firebase use <projectId>" in to set the active project.');
    process.exit(1);
  }
  console.log(`\nDeploying optimized functions from directory: "${rootDir}" to project "${projectId}"`);


  console.timeEnd('Initializing...');

  copyPackageJSON(functionsDir);
  const packageJSON = loadJSON(path.resolve(functionsDir, 'package-updated.json'));
  sh.rm(path.resolve(functionsDir, 'package-updated.json'));

  console.log('Building project...');
  console.time('Building project...');
  try {
    buildProject(functionsDir);
  } catch (error) {
    console.error('Cannot build project - are node_modules installed?', error.message);
    process.exit(1);
  } finally {
    console.timeEnd('Building project...');
  }

  console.log('Analyzing project...');
  console.time('Analyzing project...');
  const allTriggers = await getTriggers(functionsDir, projectId);
  const triggers = allTriggers.filter((trigger) => {
    return functions.length === 0 || functions.includes(trigger.entryPoint);
  });

  if (functions.length > 0 && functions.length !== triggers.length) {
    const foundFunctions = triggers.map((trigger) => trigger.entryPoint);
    const missingFunctions = functions.filter((fn) => !foundFunctions.includes(fn));
    throw new Error(`Cannot find all functions that should have been deployed\n missing functions: ${missingFunctions.join(' ')}`);
  }

  if (triggers.length === 0) {
    console.error('No Cloud Functions found in the project');
    process.exit(1);
  }

  console.timeEnd('Analyzing project...');

  const subprojectsDir = path.resolve(rootDir, '.foundry');

  sh.rm('-fR', subprojectsDir);

  const subprojects = triggers.map((trigger) => {
    console.log(`Creating a separate project for the function "${trigger.entryPoint}"...`);
    console.time(`Creating a separate project for the function "${trigger.entryPoint}"...`);
    const subproject = createSubproject(rootDir, functionsDir, trigger.entryPoint);
    console.timeEnd(`Creating a separate project for the function "${trigger.entryPoint}"...`);
    return {
      trigger,
      ...subproject,
    };
  });

  const movedSubprojectsDir = path.resolve(functionsDir, '.foundry');

  sh.rm('-fR', movedSubprojectsDir);
  sh.mv('-f', subprojectsDir, movedSubprojectsDir);

  try {
    for (const subproject of subprojects) {
      try {
        console.log(`Isolating function "${subproject.trigger.entryPoint}"...`);
        console.time(`Isolating function "${subproject.trigger.entryPoint}"...`);
        isolateEntryPoint(subproject.movedFunctionsDir, subproject.trigger.entryPoint);
        console.timeEnd(`Isolating function "${subproject.trigger.entryPoint}"...`);

        console.log(`Removing unused ts files "${subproject.trigger.entryPoint}"...`);
        console.time(`Removing unused ts files "${subproject.trigger.entryPoint}"...`);
        removeUnusedFiles(subproject.movedFunctionsDir);
        console.timeEnd(`Removing unused ts files "${subproject.trigger.entryPoint}"...`);

        console.log(`Pruning package "${subproject.trigger.entryPoint}"...`);
        console.time(`Pruning package "${subproject.trigger.entryPoint}"...`);
        const prunedPackage = await prunePackages(subproject.movedFunctionsDir, packageJSON);
        console.timeEnd(`Pruning package "${subproject.trigger.entryPoint}"...`);

        console.log(`Adding bundler "${subproject.trigger.entryPoint}"...`);
        console.time(`Adding bundler "${subproject.trigger.entryPoint}"...`);
        const bundlerPackage = addBundler(prunedPackage);
        console.timeEnd(`Adding bundler "${subproject.trigger.entryPoint}"...`);

        console.log(`Saving project files "${subproject.trigger.entryPoint}"...`);
        console.time(`Saving project files "${subproject.trigger.entryPoint}"...`);
        saveJSON(path.resolve(subproject.movedFunctionsDir, 'package.json'), bundlerPackage);
        console.timeEnd(`Saving project files "${subproject.trigger.entryPoint}"...`);

        console.log(`Building subproject "${subproject.trigger.entryPoint}"...`);
        console.time(`Building subproject "${subproject.trigger.entryPoint}"...`);
        sh.rm('-Rf', path.resolve(subproject.movedFunctionsDir, 'lib'));
        buildProject(subproject.movedFunctionsDir);
        sh.rm('-Rf', path.resolve(subproject.movedFunctionsDir, 'src'));
        console.timeEnd(`Building subproject "${subproject.trigger.entryPoint}"...`);

        console.log(`Deploying function "${subproject.trigger.entryPoint}"...`);
        console.time(`Deploying function "${subproject.trigger.entryPoint}"...`);
        deploySubproject(subproject.movedFunctionsDir, subproject.trigger.entryPoint, projectId, debug);
        console.timeEnd(`Deploying function "${subproject.trigger.entryPoint}"...`);
      } catch (error) {
        throw error;
      }
    }

  } catch (error) {
    console.log(error);
    throw error;
  } finally {
    sh.rm('-fR', movedSubprojectsDir);
  }
}

exports.deploy = deploy;
