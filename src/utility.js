const fs = require('fs-extra');


function loadJSON(path) {
  const raw = fs.readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function saveJSON(path, data) {
  fs.writeJSONSync(path, data);
}

function isEmpty(obj) {
  for (var prop in obj) {
    if (obj.hasOwnProperty(prop)) {
      return false;
    }
  }
  return JSON.stringify(obj) === JSON.stringify({});
}

function objClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function flattenObject(ob) {
  var toReturn = {};
  for (var i in ob) {
    if (!ob.hasOwnProperty(i)) continue;
    if ((typeof ob[i]) == 'object' && ob[i] !== null) {
      var flatObject = flattenObject(ob[i]);
      for (var x in flatObject) {
        if (!flatObject.hasOwnProperty(x)) continue;
        toReturn[i + '.' + x] = flatObject[x];
      }
    } else {
      toReturn[i] = ob[i];
    }
  }
  return toReturn;
}

exports.flattenObject = flattenObject;
exports.isEmpty = isEmpty;
exports.objClone = objClone;
exports.saveJSON = saveJSON;
exports.loadJSON = loadJSON;