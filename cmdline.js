var keypress = require('keypress');
var events = require('events');
var sprintf = require('sprintf');

var prompt = '$ ';
var entry = '';
var savedEntry = '';
var position = 0;
var commands = [];
var commandPosition = -1;
var i;
var paused = false;
var bufferedKeypresses = [];
var autoCompleteCallback = null;
var tabCount = 0;
var commandCallback = null;

var exportObj = {};

exportObj.events = new events.EventEmitter();

exportObj.setAutoCompleteCallback = function(callback) {
  autoCompleteCallback = callback;
}

exportObj.getCommand = function(customPrompt, callback) {
  var keypress;

  if (typeof customPrompt === 'function') {
    callback = customPrompt;
    customPrompt = null;
  }

  if (customPrompt) {
    process.stdout.write(customPrompt);
  } else {
    process.stdout.write(prompt);
  }

  if (callback) {
    commandCallback = callback;
  } else {
    commandCallback = null;
  }

  paused = false;

  while ((bufferedKeypresses.length !== 0) &&
         !paused) {
    keypress = bufferedKeypresses[0];
    bufferedKeypresses.shift();
    processKey(keypress.ch, keypress.key);
  }
};

function processKey(ch, key) {
  if (typeof key === 'undefined') {
    key = { name: '' };
  }

  if (key.name !== 'tab') {
    tabCount = 0;
  }

  switch (key.name) {
    case 'left':
      if (position > 0) {
        --position;
        process.stdout.write('\x08');
      }
      break;

    case 'right':
      if (position < entry.length) {
        process.stdout.write(entry.substr(position, entry.length));
        ++position;
        for (i = position; i < entry.length; ++i) {
          process.stdout.write('\x08');
        }
      }
      break;

    case 'up':
      if (commandPosition === commands.length) {
        savedEntry = entry;
      }
      if (commandPosition > 0) {
        for (i = 0; i < position; ++i) {
          process.stdout.write('\x08');
        }
        for (i = 0; i < entry.length; ++i) {
          process.stdout.write(' ');
        }
        for (i = 0; i < entry.length; ++i) {
          process.stdout.write('\x08');
        }

        --commandPosition;
        entry = commands[commandPosition];
        position = entry.length;

        process.stdout.write(entry);
      }
      break;

    case 'down':
      if (commandPosition === (commands.length - 1)) {
        for (i = 0; i < position; ++i) {
          process.stdout.write('\x08');
        }
        for (i = 0; i < entry.length; ++i) {
          process.stdout.write(' ');
        }
        for (i = 0; i < entry.length; ++i) {
          process.stdout.write('\x08');
        }

        ++commandPosition;
        entry = savedEntry;
        savedEntry = '';
        position = entry.length;

        process.stdout.write(entry);
      } else {
        if (commandPosition < (commands.length - 1)) {
          for (i = 0; i < position; ++i) {
            process.stdout.write('\x08');
          }
          for (i = 0; i < entry.length; ++i) {
            process.stdout.write(' ');
          }
          for (i = 0; i < entry.length; ++i) {
            process.stdout.write('\x08');
          }

          ++commandPosition;
          entry = commands[commandPosition];
          position = entry.length;

          process.stdout.write(entry);
        }
      }
      break;

    case 'return':
      savedEntry = '';
      position = 0;

      if (!paused) {
        console.log();

        if (entry === 'history') {
          commands.push(entry);
          commandPosition = commands.length;

          for (var i = 0; i < commands.length; ++i) {
            console.log(sprintf.sprintf(' %3d  %s', i + 1, commands[i]));
          }
          console.log();
          process.stdout.write(prompt);
        } else {
          paused = true;

          if (commandCallback) {
            commandCallback(null, entry);
          } else {
            if (entry !== '') {
              commands.push(entry);
              commandPosition = commands.length;
            }

            exportObj.events.emit('command', entry);
          }
        }
      }

      entry = '';
      break;

    case 'backspace':
      if (position > 0) {
        --position;
        entry = entry.substr(0, position) + entry.substr(position + 1, entry.length);
        process.stdout.write('\x08');
        process.stdout.write(entry.substr(position, entry.length));
        process.stdout.write(' ');
        for (i = 0; i < entry.length - position + 1; ++i) {
          process.stdout.write('\x08');
        }
      }
      break;

    case 'delete':
      if (position < entry.length) {
        entry = entry.substr(0, position) + entry.substr(position + 1, entry.length);
        process.stdout.write(entry.substr(position, entry.length));
        process.stdout.write(' ');
        for (i = 0; i < entry.length - position + 1; ++i) {
          process.stdout.write('\x08');
        }
      }
      break;

    case 'home':
      while (position > 0) {
        --position;
        process.stdout.write('\x08');
      }
      break;

    case 'end':
      process.stdout.write(entry.substr(position, entry.length));
      position = entry.length;
      break;

    case 'tab':
      if (entry.length && (autoCompleteCallback !== null)) {
        var match = false;
        autoCompleteCallback(function(err, autoCompleteObj) {
          if (err) {
          } else {
            if (autoCompleteObj) {
              var keys = Object.keys(autoCompleteObj);
              if (keys.length) {
                if (entry.indexOf(' ') === -1) {
                  attemptAutoCompletion([], entry, keys);
                } else {
                  var fields = entry.split(' ');
                  var cmd = fields[0];
                  var arg = fields.pop();
                  for (i = 0; i < keys.length; ++i) {
                    if (cmd === keys[i]) {
                      attemptAutoCompletion(fields, arg, autoCompleteObj[cmd]);

                      match = true;
                      break;
                    }
                  }

                  if (!match) {
                    tabCount = 0;
                  }
                }
              }
            }
          }
        });
      }
      break;

    default:
      if (ch) {
        if (ch.match(/[a-zA-Z0-9\.\?:/_\- ]/)) {
          if (position < entry.length) {
            entry = entry.substr(0, position) + ch + entry.substr(position, entry.length);
            process.stdout.write(entry.substr(position, entry.length));
            for (i = position; i < entry.length; ++i) {
              process.stdout.write('\x08');
            }
            ++position;
          } else {
            entry += ch;
            ++position;
          }
          process.stdout.write(ch);
        } else {
          if (key.ctrl === true) {
            switch (key.name) {
              case 'a':
                while (position > 0) {
                  --position;
                  process.stdout.write('\x08');
                }
                break;

              case 'c':
                process.kill(process.pid);
                break;

              case 'e':
                process.stdout.write(entry.substr(position, entry.length));
                position = entry.length;
                break;

              default:
                break;
            }
          }
        }
      }
      break;
  }
}

function attemptAutoCompletion(args, strToMatch, list) {
  var matches = [];
  var shortestMatch = 500;
  var longestMatch = 0;
  for (var i = 0; i < list.length; ++i) {
    if (list[i].indexOf(strToMatch) === 0) {
      matches.push(list[i]);
      if (list[i].length < shortestMatch) {
        shortestMatch = list[i].length;
      }
      if (list[i].length > longestMatch) {
        longestMatch = list[i].length;
      }
    }
  }

  if (matches.length === 1) {
    tabCount = 0;

    if (args.length) {
      args.push(matches[0]);
      entry = args.join(' ');
    } else {
      entry = matches[0];
    }

    process.stdout.write(entry.substr(position, entry.length));
    position = entry.length;
  } else {
    if (matches.length === 0) {
      tabCount = 0;
    } else {
      if (++tabCount < 2) {
        var matchingChars = strToMatch;
        var testMatch = '';
        var match = true;
        for (i = matchingChars.length; i < shortestMatch; ++i) {
          testMatch = matchingChars + matches[0][i];
          for (var j = 0; j < matches.length; ++j) {
            if (matches[j].indexOf(testMatch) !== 0) {
              match = false;
              break;
            }
          }

          if (match) {
            matchingChars += matches[0][i];
          } else {
            if (args.length) {
              args.push(matchingChars);
              entry = args.join(' ');
            } else {
              entry = matchingChars;
            }

            process.stdout.write(entry.substr(position, entry.length));
            position = entry.length;
            break;
          }
        }
      } else {
        var terminalWidth = process.stdout.getWindowSize()[0];
        var columnWidth = longestMatch + 5;
        var columns = Math.floor(terminalWidth / columnWidth);
        for (i = 0; i < matches.length; ++i) {
          if ((i % columns) === 0) {
            console.log();
          }
          process.stdout.write(matches[i]);
          for (j = matches[i].length; j < columnWidth; ++j) {
            process.stdout.write(' ');
          }
        }
        console.log();

        if (args.length) {
          args.push(strToMatch);
          entry = args.join(' ');
        } else {
          entry = strToMatch;
        }

        process.stdout.write(prompt + entry);
      }
    }
  }
}

(function start() {
  keypress(process.stdin);

  process.stdin.on('keypress', function(ch, key) {
    if (paused) {
      if (key && (key.ctrl === true) && (key.name === 'c')) {
        processKey(ch, key);
      } else {
        var keypressObj = {};
        keypressObj.ch = ch;
        keypressObj.key = key;
        bufferedKeypresses.push(keypressObj);
      }
    } else {
      processKey(ch, key);
    }
  });

  process.stdin.setRawMode(true);
})();

module.exports = exportObj;
