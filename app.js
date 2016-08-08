'use strict';

var async      = require('async');
var fs         = require('fs');
var moment     = require('moment');
var sprintf    = require('sprintf');
var config     = require('yaml-config');
var Connection = require('ssh2');
var nopt       = require('nopt');
var path       = require('path');
var cp         = require('child_process');
var pkg        = require('./package.json');
var _          = require('lodash');
var cmdline    = require('./cmdline');

var conn = new Connection();

var cfgLocalPath = null;
var localFiles = [];

var cfgRemotePath = null;
var remoteFiles = [];

var sftpSession = null;

var cfgSftpHost = null;
var cfgSftpPort = null;
var cfgSftpUsername = null;
var cfgSftpPassword = null;
var cfgSftpPrivateKey = null;
var cfgAraxisMergeExe = null;
var cfgAraxisMergeCommandSeparator = null;
var cfgRecursive = null;

var configFile = null;

var ignoreFileList = [];

function usage() {
  var exec = process.argv[0] + ' ' + path.basename(process.argv[1]);

  console.log('Usage:');
  console.log('  %s -c filename', exec);
  console.log('Options:');
  console.log('  -c, --config [filename]   app configuration file');
  console.log('  -v, --version             display app version');
  console.log('  -h, --help                display app usage');
  console.log('Examples:');
  console.log('  %s -c ./etc/config.yaml', exec);
  process.exit(0);
}

var longOptions = {
  'config'  : String,
  'version' : Boolean,
  'help'    : Boolean
};

var shortOptions = {
  'c' : ['--config'],
  'v' : ['--version'],
  'h' : ['--help']
};

var argv = nopt(longOptions, shortOptions, process.argv, 2);

if (argv.version) {
  var json = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log(json.version);
  process.exit(0);
}

if (argv.help) {
  usage();
}

if (argv.version) {
  var json = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log(json.version);
  process.exit(0);
}

if (argv.config) {
  configFile = argv.config;
}
else {
  usage();
}

function getLine() {
  var stack = new Error().stack.split('\n');
  var line = stack[2].split(':');
  return parseInt(line[line.length - 2], 10);
}

function readSyncIgnoreFile(callback) {
  fs.stat(cfgLocalPath + '/.file_syncignore', function(err, stats) {
    if (!err) {
      if (stats.isFile()) {
        var contents = fs.readFileSync(cfgLocalPath + '/.file_syncignore', 'utf8');
        if (contents) {
          ignoreFileList = contents.trim().split('\r\n');
          ignoreFileList.push('.file_syncignore');
        }
      }
    }

    callback(null);
  });
}

function loadConfig() {
  var settings = config.readConfig(configFile);

  if (Object.keys(settings).length === 0) {
    console.log('Error at line %d: readConfig: %s', getLine(), configFile);
    process.exit(1);
  }

  function checkArg(arg, name) {
    if (typeof arg === 'undefined') {
      console.log('Error at line %d: %s: not found: %s', getLine(), configFile, name);
      process.exit(1);
    }
    return arg;
  }

  cfgLocalPath                   = checkArg(settings.localPath,                   'localPath');
  cfgRemotePath                  = checkArg(settings.remotePath,                  'remotePath');
  cfgSftpHost                    = checkArg(settings.sftp.host,                   'sftp.host');
  cfgSftpPort                    = checkArg(settings.sftp.port,                   'sftp.port');
  cfgSftpUsername                = checkArg(settings.sftp.username,               'sftp.username');
  if (typeof settings.sftp.privateKey !== 'undefined') {
    cfgSftpPrivateKey = settings.sftp.privateKey;
  } else {
    if (typeof settings.sftp.password !== 'undefined') {
      cfgSftpPassword = settings.sftp.password;
    } else {
      console.log('No privateKey or password found');
      process.exit(1);
    }
  }
  cfgAraxisMergeExe              = checkArg(settings.araxisMergeExe,              'araxisMergeExe');
  cfgAraxisMergeCommandSeparator = checkArg(settings.araxisMergeCommandSeparator, 'araxisMergeCommandSeparator');
  cfgRecursive                   = checkArg(settings.recursive,                   'recursive');
}

conn.on('ready', function() {
  console.log('Connection ready');
  console.log();

  async.series(
    [
      function(seriesCallback) {
        conn.exec('date +\'%s\'', function(err, stream) {
          if (err) {
            console.log('error retrieving date from remote at line %d: %s', getLine(), err);
          }
          else {
            stream.on('data', function(data) {
              console.log('Remote host time ... %s', moment.unix(data.toString()).format('YYYY/MM/DD HH:mm:ss Z'));
            });

            stream.on('end', function() {
              seriesCallback(null);
            });
          }
        });
      },
      function(seriesCallback) {
        console.log('Local host time .... %s', moment().format('YYYY/MM/DD HH:mm:ss Z'));
        console.log();

        seriesCallback(null);
      },
      function(seriesCallback) {
        conn.sftp(function(err, sftp) {
          if (err) {
            console.log('error creating sftp at line %d: %s', getLine(), err);
            sftpSession = null;
            seriesCallback(err);
          }
          else {
            sftpSession = sftp;
            seriesCallback(null);
          }
        });
      }
    ],
    function(err) {
      if (err) {
        console.log('async.series error at line %d: %s', getLine(), err);
      }
      else {
        cmdline.getCommand();
      }
    }
  );
});

function isFileIgnored(filepath, ignoreList) {
  var temp;

  for (var i = 0; i < ignoreList.length; ++i) {
    temp = path.normalize(ignoreList[i]);
    temp = temp.replace(/([\/.\\])/g, '\\$1');
    temp = temp.replace(/([*])/g, '.$1');
    var myRe = new RegExp(temp, 'g');
    if (filepath.search(myRe) !== -1) {
      return true;
    }
  }

  return false;
}

function isDirectoryIgnored(directoryPath, ignoreList) {
  for (var i = 0; i < ignoreList.length; ++i) {
    if (path.join(directoryPath + '/') === path.normalize(ignoreList[i])) {
      return true;
    }
  }

  return false;
}

// consulting the mode flags directly seems like an unfortunate way to have to
// determine whether the object is a file or directory, but the objects returned
// by sftp.readdir do not have isFile() or isDirectory() methods, and performing
// a stat on each remote file is very expensive with a large amount of files
function isFile(modeFlags) {
  /* jshint bitwise: false */
  return ((modeFlags & 0xF000) === 0x8000);
  /* jshint bitwise: true */
}

function isDirectory(modeFlags) {
  /* jshint bitwise: false */
  return ((modeFlags & 0xF000) === 0x4000);
  /* jshint bitwise: true */
}

function getRemoteFileListByDirectory(directoryPath, callback) {
  var fileList = [];

  sftpSession.readdir(directoryPath, function(err, remoteDirList) {
    if (err) {
      console.log('sftpSession.readdir error at line %d: %s', getLine(), err);

      callback(err);
    }
    else {
      var fileObj = {};
      var filePath;
      var tokens = [];

      async.eachSeries(remoteDirList, function(remoteDir, arrayCallback) {
        if (isFile(remoteDir.attrs.mode)) {
          if (!isFileIgnored(path.relative(cfgRemotePath, directoryPath + '/' + remoteDir.filename), ignoreFileList)) {
            fileObj = {};
            filePath = path.relative(cfgRemotePath, directoryPath + '/' + remoteDir.filename);
            tokens = filePath.split('\\');
            fileObj.filename = tokens.join('/');
            fileObj.attrs = remoteDir.attrs;
            fileObj.attrs.modifiedUnix = remoteDir.attrs.mtime;
            fileList.push(fileObj);
          }

          setImmediate(arrayCallback, null);
        }
        else {
          if (isDirectory(remoteDir.attrs.mode) && cfgRecursive) {
            if (!isDirectoryIgnored(path.relative(cfgRemotePath, directoryPath + '/' + remoteDir.filename), ignoreFileList)) {
              fileObj = {};
              filePath = path.relative(cfgRemotePath, directoryPath + '/' + remoteDir.filename);
              tokens = filePath.split('\\');
              fileObj.filename = tokens.join('/');
              fileObj.attrs = remoteDir.attrs;
              fileObj.attrs.modifiedUnix = remoteDir.attrs.mtime;
              fileList.push(fileObj);

              getRemoteFileListByDirectory(directoryPath + '/' + remoteDir.filename, function(err, returnedFiles) {
                fileList = _.union(fileList, returnedFiles);
                setImmediate(arrayCallback, null);
              });
            }
            else {
              setImmediate(arrayCallback, null);
            }
          }
          else {
            setImmediate(arrayCallback, null);
          }
        }
      },
      function(err) {
        if (err) {
          console.log('async.eachSeries error at line %d: %s', getLine(), err);
          callback(err);
        }
        else {
          callback(null, fileList);
        }
      });
    }
  });
}

function getRemoteFileList(callback) {
  remoteFiles = [];

  getRemoteFileListByDirectory(cfgRemotePath, function(err, fileList) {
    remoteFiles = fileList;
    callback(err);
  });
}

function getLocalFileListByDirectory(directoryPath, callback) {
  var fileList = [];

  fs.readdir(directoryPath, function(err, localDirList) {
    var fileObj = {};
    var filePath;
    var tokens = [];

    async.eachSeries(localDirList, function(localDir, arrayCallback) {
      fs.stat(directoryPath + '/' + localDir, function(err, stats) {
        if (err) {
          console.log('fs.stat error at line %d: %s', getLine(), err);
          setImmediate(arrayCallback, err);
        }
        else {
          if (stats.isFile()) {
            if (!isFileIgnored(path.relative(cfgLocalPath, directoryPath + '/' + localDir), ignoreFileList)) {
              fileObj = {};
              filePath = path.relative(cfgLocalPath, directoryPath + '/' + localDir);
              tokens = filePath.split('\\');
              fileObj.filename = tokens.join('/');
              fileObj.attrs = stats;
              fileObj.attrs.modifiedUnix = moment(stats.mtime).unix();
              fileList.push(fileObj);
            }

            setImmediate(arrayCallback, null);
          }
          else {
            if (stats.isDirectory() && cfgRecursive) {
              if (!isDirectoryIgnored(path.relative(cfgLocalPath, directoryPath + '/' + localDir), ignoreFileList)) {
                fileObj = {};
                filePath = path.relative(cfgLocalPath, directoryPath + '/' + localDir);
                tokens = filePath.split('\\');
                fileObj.filename = tokens.join('/');
                fileObj.attrs = stats;
                fileObj.attrs.modifiedUnix = moment(stats.mtime).unix();
                fileList.push(fileObj);

                getLocalFileListByDirectory(directoryPath + '/' + localDir, function(err, returnedFiles) {
                  fileList = _.union(fileList, returnedFiles);
                  setImmediate(arrayCallback, null);
                });
              }
              else {
                setImmediate(arrayCallback, null);
              }
            }
            else {
              setImmediate(arrayCallback, null);
            }
          }
        }
      });
    },
    function(err) {
      if (err) {
        console.log('async.eachSeries error at line %d: %s', getLine(), err);
        callback(err);
      }
      else {
        callback(null, fileList);
      }
    });
  });
}

function getLocalFileList(callback) {
  localFiles = [];

  getLocalFileListByDirectory(cfgLocalPath, function(err, fileList) {
    localFiles = fileList;
    callback(err);
  });
}

function setRemoteFileModificationTime(filename, callback) {
  for (var i = 0; i < localFiles.length; ++i) {
    if (localFiles[i].filename === filename) {
      sftpSession.utimes(cfgRemotePath + '/' + filename,
                         localFiles[i].attrs.mtime,
                         localFiles[i].attrs.mtime,
                         callback);
      return;
    }
  }

  callback(null);
}

function pushFiles(filesToPush, callback) {
  if (filesToPush.length) {
    console.log('Pushing file(s)');

    async.eachSeries(filesToPush, function(file, arrayCallback) {
      console.log('  Pushing %s', file);

      for (var i = 0; i < localFiles.length; ++i) {
        if (localFiles[i].filename === file) {
          if (localFiles[i].attrs.isFile()) {
            sftpSession.fastPut(cfgLocalPath + '/' + file,
                                cfgRemotePath + '/' + file,
                                function() {
                                  setRemoteFileModificationTime(file, arrayCallback);
                                });
          }
          else {
            if (localFiles[i].attrs.isDirectory()) {
              sftpSession.mkdir(cfgRemotePath + '/' + file,
                                function() {
                                  arrayCallback(null);
                                });
            }
            else {
              arrayCallback(null);
            }
          }

          break;
        }
      }

    },
    function(err) {
      if (err) {
        console.log('async.eachSeries error at line %d: %s', getLine(), err);
        callback(err);
      }
      else {
        callback(null);
      }
    });
  }
  else {
    callback(null);
  }
}

function setLocalFileModificationTime(filename, callback) {
  for (var i = 0; i < remoteFiles.length; ++i) {
    if (remoteFiles[i].filename === filename) {
      fs.utimes(cfgLocalPath + '/' + filename,
                remoteFiles[i].attrs.mtime,
                remoteFiles[i].attrs.mtime,
                callback);
      return;
    }
  }

  callback(null);
}

function pullFiles(filesToPull, callback) {
  if (filesToPull.length) {
    console.log('Pulling file(s)');

    async.eachSeries(filesToPull, function(file, arrayCallback) {
      console.log('  Pulling %s', file);

      for (var i = 0; i < remoteFiles.length; ++i) {
        if (remoteFiles[i].filename === file) {
          if (isFile(remoteFiles[i].attrs.mode)) {
            sftpSession.fastGet(cfgRemotePath + '/' + file,
                                cfgLocalPath + '/' + file,
                                function() {
                                  setLocalFileModificationTime(file, arrayCallback);
                                });
          }
          else {
            if (isDirectory(remoteFiles[i].attrs.mode)) {
              fs.mkdirSync(cfgLocalPath + '/' + file);
            }

            arrayCallback(null);
          }

          break;
        }
      }
    },
    function(err) {
      if (err) {
        console.log('async.eachSeries error at line %d: %s', getLine(), err);
        callback(err);
      }
      else {
        callback(null);
      }
    });
  }
  else {
    callback(null);
  }
}

function getFileDiffList(filterList, callback) {
  var filesToCompare = [];

  async.series(
    [
      function(seriesCallback) {
        getRemoteFileList(seriesCallback);
      },
      function(seriesCallback) {
        getLocalFileList(seriesCallback);
      },
    ],
    function(err) {
      if (err) {
        console.log('async.series error at line %d: %s', getLine(), err);
      }
      else {
        var i;
        var j;

        for (i = 0; i < localFiles.length; ++i) {
          for (j = 0; j < remoteFiles.length; ++j) {
            var fileObj = {};

            if (localFiles[i].filename === remoteFiles[j].filename) {
              if (localFiles[i].attrs.isFile()) {
                if (filterList.length) {
                  if (filterList.indexOf(localFiles[i].filename) !== -1) {
                    fileObj.bLocalFileFirst = localFiles[i].attrs.modifiedUnix <= remoteFiles[j].attrs.modifiedUnix ? true : false;
                    fileObj.filename = localFiles[i].filename;
                    filesToCompare.push(fileObj);
                  }
                }
                else {
                  if (localFiles[i].attrs.modifiedUnix !== remoteFiles[j].attrs.modifiedUnix) {
                    fileObj.bLocalFileFirst = localFiles[i].attrs.modifiedUnix <= remoteFiles[j].attrs.modifiedUnix ? true : false;
                    fileObj.filename = localFiles[i].filename;
                    filesToCompare.push(fileObj);
                  }
                }
              }
            }
          }
        }

        callback(filesToCompare);
      }
    }
  );
}

function displayFileInfo(localFile, remoteFile, bHeaderPrinted) {
  var localMod = '';
  var remoteMod = '';
  var line;
  var filename = '';

  if (!bHeaderPrinted) {
    console.log('  Filename                            Local Mod Time       Remote Mod Time');
    console.log('  ----------------------------------  -------------------  -------------------');
  }

  if (localFile) {
    localMod = moment.unix(localFile.attrs.modifiedUnix).format('YYYY/MM/DD HH:mm:ss');
    filename = localFile.filename;
  }

  if (remoteFile) {
    remoteMod = moment.unix(remoteFile.attrs.modifiedUnix).format('YYYY/MM/DD HH:mm:ss');
    filename = remoteFile.filename;
  }

  line = sprintf.sprintf('  %-34.34s  %-19.19s  %-19.19s', filename, localMod, remoteMod);
  console.log(line);
}

function generateListOfFilesToPush(localFilesList, remoteFilesList, args, callback) {
  var i;
  var j;
  var bFound;
  var filesToPush = [];

  console.log('Files to push: ');

  for (i = 0; i < localFilesList.length; ++i) {
    if ((args.length === 0) || (args.indexOf(localFilesList[i].filename) !== -1)) {
      bFound = false;

      for (j = 0; j < remoteFilesList.length; ++j) {
        if (localFilesList[i].filename === remoteFilesList[j].filename) {
          bFound = true;

          if (localFilesList[i].attrs.isFile()) {
            if (localFilesList[i].attrs.modifiedUnix > remoteFilesList[j].attrs.modifiedUnix) {
              displayFileInfo(localFilesList[i], remoteFilesList[j], filesToPush.length);

              filesToPush.push(localFilesList[i].filename);
            }
          }

          break;
        }
      }

      if (bFound === false) {
        displayFileInfo(localFilesList[i], remoteFilesList[j], filesToPush.length);

        filesToPush.push(localFilesList[i].filename);
      }
    }
  }

  if (filesToPush.length) {
    console.log();
  }
  else {
    console.log('  No files to push');
    console.log();
  }

  callback(filesToPush);
}

function generateListOfFilesToPull(localFilesList, remoteFilesList, args, callback) {
  var i;
  var j;
  var bFound;
  var filesToPull = [];

  console.log('Files to pull: ');

  for (i = 0; i < remoteFilesList.length; ++i) {
    if ((args.length === 0) || (args.indexOf(remoteFilesList[i].filename) !== -1)) {
      bFound = false;

      for (j = 0; j < localFilesList.length; ++j) {
        if (remoteFilesList[i].filename === localFilesList[j].filename) {
          bFound = true;

          if (isFile(remoteFilesList[i].attrs.mode)) {
            if (remoteFilesList[i].attrs.modifiedUnix > localFilesList[j].attrs.modifiedUnix) {
              displayFileInfo(localFilesList[j], remoteFilesList[i], filesToPull.length);

              filesToPull.push(remoteFilesList[i].filename);
            }
          }

          break;
        }
      }

      if (bFound === false) {
        displayFileInfo(localFilesList[j], remoteFilesList[i], filesToPull.length);

        filesToPull.push(remoteFilesList[i].filename);
      }
    }
  }

  if (filesToPull.length) {
    console.log();
  }
  else {
    console.log('  No files to pull');
    console.log();
  }

  callback(filesToPull);
}

function handleDiff(args) {
  var filterList = [];
  var tempFilename;
  var tokens = [];

  if (args[0] !== 'all') {
    filterList = args;
  }

  getFileDiffList(filterList, function(filesToCompare) {
    async.eachSeries(filesToCompare, function(file, arrayCallback) {
      tokens = file.filename.split('/');
      tempFilename = '/tmp/rmt_' + tokens.join('_');

      console.log('  Pulling %s into temporary file %s for comparison', file.filename, tempFilename);

      sftpSession.fastGet(cfgRemotePath + '/' + file.filename,
                          cfgLocalPath + tempFilename,
                          function() {
                            var localFilePath = cfgLocalPath + '/' + file.filename;
                            var remoteFilePath = cfgLocalPath + tempFilename;
                            var titles;
                            var araxisArgs;
                            if (file.bLocalFileFirst) {
                              titles = cfgAraxisMergeCommandSeparator + 'title1:\"Local ' + file.filename + '\" ' + cfgAraxisMergeCommandSeparator + 'title2:\"Remote ' + file.filename + '\"';
                              araxisArgs = titles + ' ' + path.normalize(localFilePath) + ' ' + path.normalize(remoteFilePath);
                            }
                            else {
                              titles = cfgAraxisMergeCommandSeparator + 'title1:\"Remote ' + file.filename + '\" ' + cfgAraxisMergeCommandSeparator + 'title2:\"Local ' + file.filename + '\"';
                              araxisArgs = titles + ' ' + path.normalize(remoteFilePath) + ' ' + path.normalize(localFilePath);
                            }
                            cp.exec('\"' + cfgAraxisMergeExe + '\" ' + araxisArgs, function(err) {
                              if (err) {
                                console.log(err);
                                setImmediate(arrayCallback, err);
                              }
                              else {
                                setImmediate(arrayCallback, null);
                              }
                            });
                          });
    },
    function(err) {
      if (err) {
        console.log('async.eachSeries error at line %d: %s', getLine(), err);
      }
      else {
        console.log();
        cmdline.getCommand();
      }
    });
  });
}

function processCommand(commandString) {
  var bPush = false;
  var bPull = false;
  var filesToPull = [];
  var filesToPush = [];
  var args = [];
  var command;

  if (commandString.length === 0) {
    cmdline.getCommand();
    return;
  }

  args = commandString.split(' ');
  command = args[0];
  args.shift();

  switch (command) {
    case 'pull':
      bPull = true;
      break;

    case 'push':
      bPush = true;
      break;

    case 'sync':
      bPull = true;
      bPush = true;
      break;

    case 'exit':
      setTimeout(function() { process.exit(0); }, 500);
      return;
      //break;

    case 'diff':
      handleDiff(args);
      break;

    case 'help':
    case '?':
      console.log('  Note that the push, pull, and sync commands use the file modification');
      console.log('  times to try to be smart about which files need to be pushed or pulled');
      console.log();
      console.log('  push [filename1]... - Displays a list of files to be pushed to the');
      console.log('                        remote target and requests permission to push');
      console.log('                        the files.  If filenames are specified, only');
      console.log('                        those files will be considered.');
      console.log('  pull [filename1]... - Displays a list of files to be pulled from the');
      console.log('                        remote target and requests permission to pull the');
      console.log('                        files.  If filenames are specified, only those files');
      console.log('                        files will be considered.');
      console.log('  sync [filename1]... - Displays a list of files to be pushed or pulled');
      console.log('                        to/from the remote target and requests permission');
      console.log('                        to push the files.  If filenames are specified,');
      console.log('                        only those files will be considered.');
      console.log('  diff [filename1]... - Opens Araxis Merge to compare the version of a file');
      console.log('                        from the local and remote directories.  If "all" is');
      console.log('                        specified or no filenames are specified, this command');
      console.log('                        opens all files for comparison that exist in both the');
      console.log('                        local and remote directories, and have different');
      console.log('                        file modification times.');
      console.log('  exit                - Exits the application.');
      console.log('  help, ?             - Displays the help menu.');
      console.log();
      cmdline.getCommand();
      break;

    default:
      console.log('unrecognized command');
      console.log();
      cmdline.getCommand();
      break;
  }

  if (sftpSession !== null) {
    if (bPush || bPull) {
      async.series(
        [
          function(seriesCallback) {
            readSyncIgnoreFile(seriesCallback);
          },
          function(seriesCallback) {
            getRemoteFileList(seriesCallback);
          },
          function(seriesCallback) {
            getLocalFileList(seriesCallback);
          },
          function(seriesCallback) {
            if (bPush) {
              generateListOfFilesToPush(localFiles, remoteFiles, args, function(files) {
                filesToPush = files;
                seriesCallback(null);
              });
            }
            else {
              seriesCallback(null);
            }
          },
          function(seriesCallback) {
            if (bPull) {
              generateListOfFilesToPull(localFiles, remoteFiles, args, function(files) {
                filesToPull = files;
                seriesCallback(null);
              });
            }
            else {
              seriesCallback(null);
            }
          }
        ],
        function(err) {
          if (err) {
            console.log('async.series error at line %d: %s', getLine(), err);
          }
          else {
            if (filesToPush.length || filesToPull.length) {
              cmdline.getCommand('Do you wish to perform this operation? (y/n): ', function(err, input) {
                if (err === null) {
                  if ((input[0] === 'y') || (input[0] === 'Y')) {
                    async.series(
                      [
                        function(seriesCallback) {
                          pushFiles(filesToPush, seriesCallback);
                        },
                        function(seriesCallback) {
                          pullFiles(filesToPull, seriesCallback);
                        }
                      ],
                      function(err) {
                        if (err) {
                          console.log('async.series error at line %d: %s', getLine(), err);
                        }

                        console.log();

                        cmdline.getCommand();
                      }
                    );
                  }
                  else {
                    console.log('No operations performed');
                    console.log();

                    cmdline.getCommand();
                  }
                }
                else {
                  console.log('No operations performed');
                  console.log();

                  cmdline.getCommand();
                }
              });
            }
            else {
              console.log('No operations necessary');
              console.log();

              cmdline.getCommand();
            }
          }
        }
      );
    }
  }
}

function autoComplete(callback) {
  async.series(
    [
      function(seriesCallback) {
        readSyncIgnoreFile(seriesCallback);
      },
      function(seriesCallback) {
        getRemoteFileList(seriesCallback);
      },
      function(seriesCallback) {
        getLocalFileList(seriesCallback);
      }
    ],
    function(err) {
      if (!err) {
        var localFilenames = [];
        var remoteFilenames = [];
        var i;
        var j;
        for (i = 0; i < localFiles.length; ++i) {
          localFilenames.push(localFiles[i].filename);
        }
        localFilenames.sort();
        for (i = 0; i < remoteFiles.length; ++i) {
          remoteFilenames.push(remoteFiles[i].filename);
        }
        remoteFilenames.sort();
        var intersection = [];
        for (i = 0; i < localFilenames.length; ++i) {
          for (j = 0; j < remoteFilenames.length; ++j) {
            if (localFilenames[i] === remoteFilenames[j]) {
              intersection.push(localFilenames[i]);
              break;
            }
          }
        }
        var union = [];
        for (i = 0; i < localFilenames.length; ++i) {
          union.push(localFilenames[i]);
        }

        var found;
        for (i = 0; i < remoteFilenames.length; ++i) {
          found = false;
          for (j = 0; j < union.length; ++j) {
            if (remoteFilenames[i] === union[j]) {
              found = true;
              break;
            }
          }

          if (!found) {
            union.push(remoteFilenames[i]);
          }
        }
        union.sort();
        var commands = {
          push: localFilenames,
          pull: remoteFilenames,
          sync: union,
          diff: intersection,
          help: []
        };

        callback(null, commands);
      }
    }
  );
}

(function startup() {
  loadConfig();

  console.log('%s v%s', pkg.name, pkg.version);
  console.log('Remote directory is %s', cfgRemotePath);
  console.log('Local directory is %s', cfgLocalPath);
  console.log();

  console.log('Connecting to remote...');

  cmdline.events.on('command', processCommand);
  cmdline.setAutoCompleteCallback(autoComplete);

  var options = {
    host:         cfgSftpHost,
    port:         cfgSftpPort,
    username:     cfgSftpUsername,
    readyTimeout: 99999
  };

  if (cfgSftpPrivateKey !== null) {
    options.privateKey = fs.readFileSync(cfgSftpPrivateKey);
  } else {
    options.password = cfgSftpPassword;
  }

  conn.connect(options);
})();
