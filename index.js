#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const fs = require('fs-extra');

const { deploy } = require('./lib/deploy');
const { firebase } = require('./lib/firebase');
const packageJSON = require('./package.json');
const { write } = require('fs');



program.version(packageJSON.version, '-v, --version');

program
  .command('deploy [functions...]')
  .option('--debug <file>')
  .action(async (functions, cmdObj) => {
    const sourceDir = process.cwd();

    // if (cmdObj.debug) {
    //   console.log('DEBUG MODE');
    //   const access = fs.createWriteStream(path.resolve(cmdObj.debug), { autoClose: true });
    //   process.stdout.pipe(access);
    // }

    const deployObjs = await deploy(sourceDir, functions, cmdObj.debug)
    await firebase.saveDeploy(deployObjs);
  });

program.parse(process.argv);
