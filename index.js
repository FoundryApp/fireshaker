#!/usr/bin/env node

const { program } = require('commander');

const { deployOptimized } = require('./lib/deploy');
const { firebase } = require('./lib/firebase');

program.parse(process.argv);

program
  .command('deploy <firebaseDir> [functionNames]')
  .action(async (sourceDir, functionNames) => {
    if (functionNames) {
      const parsedFunctionNames = functionNames.split(',');

      // deployObj =  {
      //   funcName: string;
      //   funcUrl: string;
      //   deployTimestamp: number;
      //   commit: string;
      //   projectId: string;
      // }
      const deployObj = await deployOptimized(sourceDir, parsedFunctionNames);
      await firebase.saveDeploy(deployObj);
    } else {
      await deployOptimized(sourceDir);
    }
  });
