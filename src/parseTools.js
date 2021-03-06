// Various tools for parsing LLVM. Utilities of various sorts, that are
// specific to Emscripten (and hence not in utility.js).

// Does simple 'macro' substitution, using Django-like syntax,
// {{{ code }}} will be replaced with |eval(code)|.
function processMacros(text) {
  return text.replace(/{{{[^}]+}}}/g, function(str) {
    str = str.substr(3, str.length-6);
    return eval(str).toString();
  });
}

// Simple #if/else/endif preprocessing for a file. Checks if the
// ident checked is true in our global. Also replaces some constants.
function preprocess(text, constants) {
  for (constant in constants) {
    text = text.replace(eval('/' + constant + '/g'), constants[constant]);
  }
  var lines = text.split('\n');
  var ret = '';
  var showStack = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line[0] != '#') {
      if (showStack.indexOf(false) == -1) {
        ret += line + '\n';
      }
    } else {
      if (line[1] == 'i') { // if
        var ident = line.substr(4);
        showStack.push(!!this[ident] && this[ident] > 0);
      } else if (line[2] == 'l') { // else
        showStack.push(!showStack.pop());
      } else if (line[2] == 'n') { // endif
        showStack.pop();
      } else {
        throw "Unclear preprocessor command: " + line;
      }
    }
  }
  assert(showStack.length == 0);
  return ret;
}

function addPointing(type) { return type + '*' }
function removePointing(type, num) {
  if (num === 0) return type;
  return type.substr(0, type.length-(num ? num : 1));
}

function pointingLevels(type) {
  if (!type) return 0;
  var ret = 0;
  var len1 = type.length - 1;
  while (type[len1-ret] === '*') {
    ret ++;
  }
  return ret;
}

function removeAllPointing(type) {
  return removePointing(type, pointingLevels(type));
}

function toNiceIdent(ident) {
  assert(ident);
  if (parseFloat(ident) == ident) return ident;
  if (ident == 'null') return '0'; // see parseNumerical
  return ident.replace('%', '$').replace(/["&\\ \.@:<>,\*\[\]-]/g, '_');
}

// Kind of a hack. In some cases we have strings that we do not want
// to |toNiceIdent|, as they are the output of previous processing. We
// should refactor everything into an object, with an explicit flag
// saying what has been |toNiceIdent|ed. Until then, this will detect
// simple idents that are in need of |toNiceIdent|ation. Or, we should
// ensure that processed strings never start with %,@, e.g. by always
// enclosing them in ().
function toNiceIdentCarefully(ident) {
  if (ident[0] == '%' || ident[0] == '@') ident = toNiceIdent(ident);
  return ident;
}

function isStructPointerType(type) {
  // This test is necessary for clang - in llvm-gcc, we
  // could check for %struct. The downside is that %1 can
  // be either a variable or a structure, and we guess it is
  // a struct, which can lead to |call i32 %5()| having
  // |%5()| as a function call (like |i32 (i8*)| etc.). So
  // we must check later on, in call(), where we have more
  // context, to differentiate such cases.
  // A similar thing happns in isStructType()
  return !Runtime.isNumberType(type) && type[0] == '%';
}

function isStructType(type) {
  if (isPointerType(type)) return false;
  if (new RegExp(/^\[\d+\ x\ (.*)\]/g).test(type)) return true; // [15 x ?] blocks. Like structs
  // See comment in isStructPointerType()
  return !Runtime.isNumberType(type) && type[0] == '%';
}

function isPointerType(type) {
  return pointingLevels(type) > 0;
}

function isVoidType(type) {
  return type == 'void';
}

// Detects a function definition, ([...|type,[type,...]])
function isFunctionDef(token) {
  var text = token.text;
  var nonPointing = removeAllPointing(text);
  if (nonPointing[0] != '(' || nonPointing.substr(-1) != ')')
    return false;
  if (nonPointing === '()') return true;
  if (!token.item) return false;
  var fail = false;
  splitTokenList(token.item.tokens).forEach(function(segment) {
    var subtext = segment[0].text;
    fail = fail || segment.length > 1 || !(isType(subtext) || subtext == '...');
  });
  return !fail;
}

function isFunctionType(type) {
  var parts = type.split(' ');
  if (parts.length != 2) return false;
  if (pointingLevels(type) !== 1) return false;
  var text = removeAllPointing(parts[1]);
  var ret = isType(parts[0]) && isFunctionDef({ text: text, item: {tokens: [{text: text.substr(1, text.length-2)}]} });
  return ret;
}

function isType(type) { // TODO!
  return isVoidType(type) || Runtime.isNumberType(type) || isStructType(type) || isPointerType(type) || isFunctionType(type);
}

function addIdent(token) {
  token.ident = token.text;
  return token;
}

function combineTokens(tokens) {
  var ret = {
    lineNum: tokens[0].lineNum,
    text: '',
    tokens: []
  };
  tokens.forEach(function(token) {
    ret.text += token.text;
    ret.tokens.push(token);
  });
  return ret;
}

function compareTokens(a, b) {
  var aId = a.__uid__;
  var bId = b.__uid__;
  a.__uid__ = 0;
  b.__uid__ = 0;
  var ret = JSON.stringify(a) == JSON.stringify(b);
  a.__uid__ = aId;
  b.__uid__ = bId;
  return ret;
}

function getTokenIndexByText(tokens, text) {
  var i = 0;
  while (tokens[i] && tokens[i].text != text) i++;
  return i;
}

function findTokenText(item, text) {
  for (var i = 0; i < item.tokens.length; i++) {
    if (item.tokens[i].text == text) return i;
  }
  return -1;
}

// Splits a list of tokens separated by commas. For example, a list of arguments in a function call
function splitTokenList(tokens) {
  if (tokens.length == 0) return [];
  if (!tokens.slice) tokens = tokens.tokens;
  if (tokens.slice(-1)[0].text != ',') tokens.push({text:','});
  var ret = [];
  var seg = [];
  var SPLITTERS = set(',', 'to'); // 'to' can separate parameters as well...
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.text in SPLITTERS) {
      ret.push(seg);
      seg = [];
    } else if (token.text == ';') {
      ret.push(seg);
      break;
    } else {
      seg.push(token);
    }
  }
  return ret;
}

// Splits an item, with the intent of later reintegration
function splitItem(parent, childSlot, copySlots) {
  if (!copySlots) copySlots = [];
  if (!parent[childSlot]) parent[childSlot] = {};
  var child = parent[childSlot];
  parent[childSlot] = null;
  child.parentUid = parent.__uid__;
  child.parentSlot = childSlot;
  child.parentLineNum = child.lineNum = parent.lineNum;
  copySlots.forEach(function(slot) { child[slot] = parent[slot] });
  return {
    parent: parent,
    child: child
  };
}

function makeReintegrator(afterFunc) {
  // Reintegration - find intermediate representation-parsed items and
  // place back in parents
  return {
    process: function(items) {
      var ret = [];
      var lineDict = {};
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item.parentSlot) {
          assert(!lineDict[item.lineNum]);
          lineDict[item.lineNum] = i;
        }
      }
      for (var i = 0; i < items.length; i++) {
        var child = items[i];
        var j = lineDict[child.parentLineNum];
        if (typeof j === 'number') {
          var parent = items[j];
          // process the pair
          parent[child.parentSlot] = child;
          delete child.parentLineNum;
          afterFunc.call(this, parent, child);

          items[i] = null;
          items[j] = null;
          lineDict[child.parentLineNum] = null;
        }
      }
      this.forwardItems(items.filter(function(item) { return !!item }), this.name_); // next time hopefully
      return ret;
    }
  };
}

function parseParamTokens(params) {
  if (params.length === 0) return [];
  var ret = [];
  if (params[params.length-1].text != ',') {
    params.push({ text: ',' });
  }
  var anonymousIndex = 0;
  while (params.length > 0) {
    var i = 0;
    while (params[i].text != ',') i++;
    var segment = params.slice(0, i);
    params = params.slice(i+1);
    segment = cleanSegment(segment);
    if (segment.length == 1) {
      if (segment[0].text == '...') {
        ret.push({
          intertype: 'varargs'
        });
      } else {
        // Clang sometimes has a parameter with just a type,
        // no name... the name is implied to be %{the index}
        ret.push({
          intertype: 'value',
          type: segment[0].text,
          value: null,
          ident: toNiceIdent('%') + anonymousIndex
        });
        Types.needAnalysis[ret.type] = 0;
        anonymousIndex ++;
      }
    } else if (segment[1].text in PARSABLE_LLVM_FUNCTIONS) {
      ret.push(parseLLVMFunctionCall(segment));
    } else {
      if (segment[2] && segment[2].text == 'to') { // part of bitcast params
        segment = segment.slice(0, 2);
      }
      while (segment.length > 2) {
        segment[0].text += segment[1].text;
        segment.splice(1, 1); // TODO: merge tokens nicely
      }
      ret.push({
        intertype: 'value',
        type: segment[0].text,
        value: segment[1],
        ident: toNiceIdent(parseNumerical(segment[1].text))
      });
      Types.needAnalysis[ret.type] = 0;
      //          } else {
      //            throw "what is this params token? " + JSON.stringify(segment);
    }
  }
  return ret;
}

// Segment ==> Parameter
function parseLLVMSegment(segment) {
  var type;
  if (segment.length == 1) {
    type = isType(segment[0].text) ? segment[0].text : '?';
    Types.needAnalysis[type] = 0;
    return {
      intertype: 'value',
      ident: toNiceIdent(segment[0].text),
      type: type
    };
  } else if (segment[1].type == '{') {
    type = segment[0].text;
    Types.needAnalysis[type] = 0;
    return {
      intertype: 'structvalue',
      values: splitTokenList(segment[1].tokens).map(parseLLVMSegment),
      type: type
    };
  } else if (segment[0].text in PARSABLE_LLVM_FUNCTIONS) {
    return parseLLVMFunctionCall([{text: '?'}].concat(segment));
  } else if (segment[1].text in PARSABLE_LLVM_FUNCTIONS) {
    return parseLLVMFunctionCall(segment);
  } else {
    type = segment[0].text;
    Types.needAnalysis[type] = 0;
    return {
      intertype: 'value',
      ident: toNiceIdent(segment[1].text),
      type: segment[0].text
    };
  }
}

function cleanSegment(segment) {
  if (segment.length == 1) return segment;
  while (['noalias', 'sret', 'nocapture', 'nest', 'zeroext', 'signext'].indexOf(segment[1].text) != -1) {
    segment.splice(1, 1);
  }
  return segment;
}

PARSABLE_LLVM_FUNCTIONS = set('getelementptr', 'bitcast', 'inttoptr', 'ptrtoint', 'mul', 'icmp', 'zext', 'sub', 'add', 'div');

// Parses a function call of form
//         TYPE functionname MODIFIERS (...)
// e.g.
//         i32* getelementptr inbounds (...)
function parseLLVMFunctionCall(segment) {
  segment = segment.slice(0);
  segment = cleanSegment(segment);
  // Remove additional modifiers
  var variant = null;
  if (!segment[2] || !segment[2].item) {
    variant = segment.splice(2, 1)[0];
    if (variant && variant.text) variant = variant.text; // needed for mathops
  }
  assertTrue(['inreg', 'byval'].indexOf(segment[1].text) == -1);
  assert(segment[1].text in PARSABLE_LLVM_FUNCTIONS);
  while (!segment[2].item) {
    segment.splice(2, 1); // Remove modifiers
    if (!segment[2]) throw 'Invalid segment!';
  }
  var intertype = segment[1].text;
  var type = segment[0].text;
  if (type === '?') {
    if (intertype === 'getelementptr') {
      type = '*'; // a pointer, we can easily say, this is
    }
  }
  var ret = {
    intertype: intertype,
    variant: variant,
    type: type,
    params: parseParamTokens(segment[2].item.tokens)
  };
  Types.needAnalysis[ret.type] = 0;
  ret.ident = toNiceIdent(ret.params[0].ident);
  return ret;
}

// Gets an array of tokens, we parse out the first
// 'ident' - either a simple ident of one token, or
// an LLVM internal function that generates an ident.
// We shift out of the array list the tokens that
// we ate.
function eatLLVMIdent(tokens) {
  var ret;
  if (tokens[0].text in PARSABLE_LLVM_FUNCTIONS) {
    ret = parseLLVMFunctionCall([{text: 'i0'}].concat(tokens.slice(0,2))).ident; // TODO: Handle more cases, return a full object, process it later
    tokens.shift();
    tokens.shift();
  } else {
    ret = tokens[0].text;
    tokens.shift();
  }
  return ret;
}

function cleanOutTokens(filterOut, tokens, index) {
  while (filterOut.indexOf(tokens[index].text) != -1) {
    tokens.splice(index, 1);
  }
}

function cleanOutTokensSet(filterOut, tokens, index) {
  while (tokens[index].text in filterOut) {
    tokens.splice(index, 1);
  }
}

function _IntToHex(x) {
  assert(x >= 0 && x <= 15);
  if (x <= 9) {
    return String.fromCharCode('0'.charCodeAt(0) + x);
  } else {
    return String.fromCharCode('A'.charCodeAt(0) + x - 10);
  }
}

function IEEEUnHex(stringy) {
  stringy = stringy.substr(2); // leading '0x';
  if (stringy.replace(/0/g, '') === '') return 0;
  while (stringy.length < 16) stringy = '0' + stringy;
  assert(stringy.length === 16, 'Can only undex 16-digit double numbers, nothing platform-specific');
  var top = eval('0x' + stringy[0]);
  var neg = !!(top & 8); // sign
  if (neg) {
    stringy = _IntToHex(top & ~8) + stringy.substr(1);
  }
  var a = eval('0x' + stringy.substr(0, 8)); // top half
  var b = eval('0x' + stringy.substr(8)); // bottom half
  var e = a >> ((52 - 32) & 0x7ff); // exponent
  a = a & 0xfffff;
  if (e === 0x7ff) {
    if (a == 0 && b == 0) {
      return 'Infinity';
    } else {
      return 'NaN';
    }
  }
  e -= 1023; // offset
  var absolute = ((((a | 0x100000) * 1.0) / Math.pow(2,52-32)) * Math.pow(2, e)) + (((b * 1.0) / Math.pow(2, 52)) * Math.pow(2, e));
  return (absolute * (neg ? -1 : 1)).toString();
}

function parseNumerical(value, type) {
  if ((!type || type == 'double' || type == 'float') && (value.substr && value.substr(0,2) == '0x')) {
    // Hexadecimal double value, as the llvm docs say,
    // "The one non-intuitive notation for constants is the hexadecimal form of floating point constants."
    value = IEEEUnHex(value);
  } else if (value == 'null') {
    // NULL *is* 0, in C/C++. No JS null! (null == 0 is false, etc.)
    value = '0';
  } else if (value === 'true') {
    return '1';
  } else if (value === 'false') {
    return '0';
  }
  if (isNumber(value)) {
    return eval(value).toString(); // will change e.g. 5.000000e+01 to 50
  } else {
    return value;
  }
}

// \0Dsometext is really '\r', then sometext
// This function returns an array of int values
function parseLLVMString(str) {
  var ret = [];
  var i = 0;
  while (i < str.length) {
    var chr = str[i];
    if (chr != '\\') {
      ret.push(chr.charCodeAt(0));
      i++;
    } else {
      ret.push(eval('0x' + str[i+1]+str[i+2]));
      i += 3;
    }
  }
  return ret;
}

function getLabelIds(labels) {
  return labels.map(function(label) { return label.ident });
}

//! Returns the size of a field, as C/C++ would have it (in 32-bit,
//! for now).
//! @param field The field type, by name
//! @param alone Whether this is inside a structure (so padding is
//!              used) or alone (line in char*, where no padding is done).
function getNativeFieldSize(field, alone) {
  if (QUANTUM_SIZE == 1) return 1;
  var size = {
    '_i1': 1,
    '_i8': 1,
    '_i16': 2,
    '_i32': 4,
    '_i64': 8,
    "_float": 4,
    "_double": 8
  }['_'+field]; // add '_' since float&double confuse closure compiler as keys
  if (!size) {
    size = QUANTUM_SIZE; // A pointer
  }
  if (!alone) size = Math.max(size, QUANTUM_SIZE);
  return size;
}

function cleanLabel(label) {
  if (label[0] == 'B') {
    return label.substr(5);
  } else {
    return label;
  }
}

function calcAllocatedSize(type) {
  if (pointingLevels(type) == 0 && isStructType(type)) {
    return Types.types[type].flatSize; // makeEmptyStruct(item.allocatedType).length;
  } else {
    return getNativeFieldSize(type, true); // We can really get away with '1', though, at least on the stack...
  }
}

// Flow blocks

function recurseBlock(block, func) {
  var ret = [];
  if (block.type == 'reloop') {
    ret.push(func(block.inner));
  } else if (block.type == 'multiple') {
    block.entryLabels.forEach(function(entryLabel) { ret.push(func(entryLabel.block)) });
  }
  ret.push(func(block.next));
  return ret;
}

function getActualLabelId(labelId) {
  return labelId.split('|').slice(-1)[0];
}

// Misc

function indentify(text, indent) {
  if (text.length > 1024*1024) return text; // Don't try to indentify huge strings - we may run out of memory
  if (typeof indent === 'number') {
    var len = indent;
    indent = '';
    for (var i = 0; i < len; i++) indent += ' ';
  }
  return text.replace(/\n/g, '\n' + indent);
}

// Correction tools

function correctSpecificSign() {
  assert(!(CORRECT_SIGNS === 2 && !Debugging.on), 'Need debugging for line-specific corrections');
  return CORRECT_SIGNS === 2 && Debugging.getIdentifier(Framework.currItem.lineNum) in CORRECT_SIGNS_LINES;
}
function correctSigns() {
  return CORRECT_SIGNS === 1 || correctSpecificSign();
}

function correctSpecificOverflow() {
  assert(!(CORRECT_OVERFLOWS === 2 && !Debugging.on), 'Need debugging for line-specific corrections');
  return CORRECT_OVERFLOWS === 2 && Debugging.getIdentifier(Framework.currItem.lineNum) in CORRECT_OVERFLOWS_LINES;
}
function correctOverflows() {
  return CORRECT_OVERFLOWS === 1 || correctSpecificOverflow();
}

function correctSpecificRounding() {
  assert(!(CORRECT_ROUNDINGS === 2 && !Debugging.on), 'Need debugging for line-specific corrections');
  return CORRECT_ROUNDINGS === 2 && Debugging.getIdentifier(Framework.currItem.lineNum) in CORRECT_ROUNDINGS_LINES;
}
function correctRoundings() {
  return CORRECT_ROUNDINGS === 1 || correctSpecificRounding();
}

