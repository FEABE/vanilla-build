// A CommonJS module: it keeps its own function wrapper inside the bundle and runs when first required.
'use strict';
exports.greeting = function (what) {
  return 'hello from a CommonJS module in the ' + what;
};
