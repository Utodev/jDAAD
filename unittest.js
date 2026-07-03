#!/usr/bin/env node
/*
  jDAAD Unit Tests (Node.js)

  Run: node unittest.js

  This is a JavaScript port of unittest.pas, the unit test suite written for
  a similar DAAD interpreter for DOS (Turbo Pascal). It exercises the same
  flag/object primitives and condacts, using an equivalent minimal, in-memory
  DDB so jdaad.js can be loaded and driven headlessly (no browser/canvas/DOM).

  Condacts that print text (GET, REMOVE...) call Sysmess()/writeText(), which
  in the real engine draws characters to an HTML canvas. Under Node there is
  no canvas, so the canvas/DOM entry points used by the text pipeline (paper,
  document.body.classList, ...) are stubbed as no-ops below - the writes are
  harmless, exactly like the Pascal suite's comment about harmless VGA writes
  in text mode. Assertions only ever check flag/object state, never printed
  text.
*/

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ============================================================================
// Minimal browser shims + sandbox in which jdaad.js is loaded
// ============================================================================

const fakeCanvasContext = {
    fillStyle: '',
    fillRect() {},
    getImageData() { return { width: 0, height: 0, data: [] }; },
    putImageData() {},
};

const fakeClassList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
const fakeElement = {
    classList: fakeClassList,
    style: {},
    focus() {},
    addEventListener() {},
    getContext() { return fakeCanvasContext; },
};

const fakeDocument = {
    body: { classList: fakeClassList },
    documentElement: {},
    getElementById() { return fakeElement; },
    addEventListener() {},
};

// jdaad.js is normally loaded in a browser with jQuery, and at file scope it
// registers a bunch of event handlers via `$(document).ready(...)`,
// `$(window).resize(...)`, etc. None of that (mouse/keyboard/resize wiring)
// is exercised by these headless condact tests, so `$` is stubbed as a
// no-op chainable: calling it or accessing any method on it just returns
// the same stub, which quietly absorbs .ready()/.show()/.css()/... calls.
const fakeJQuery = new Proxy(function () {}, {
    get() { return () => fakeJQuery; },
    apply() { return fakeJQuery; },
});

const sandbox = {
    console,
    Math,
    String,
    document: fakeDocument,
    $: fakeJQuery,
    window: { innerWidth: 800, innerHeight: 600 },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    paper: fakeCanvasContext,
    doublebuffer: fakeCanvasContext,
    swapbuffer: fakeCanvasContext,
    // Placeholder DDB image so DDBClass's constructor (which reads header
    // fields out of DDBDATA at load time) doesn't crash. Real content is
    // written by initTestDDB() below, once jdaad.js has finished loading.
    DDBDATA: new Uint8Array(4096),
};
vm.createContext(sandbox);

function loadScript(relPath) {
    const code = fs.readFileSync(path.join(__dirname, relPath), 'utf8');
    vm.runInContext(code, sandbox, { filename: relPath });
}

loadScript('font.js');
loadScript('jdaad.js');

// `const`-declared identifiers in jdaad.js (constants, message numbers...)
// don't become own properties of the sandbox global object the way `var`s
// and function declarations do, so pull the ones we need onto it explicitly.
const NEEDED_CONSTANTS = [
    'NO_WORD', 'LOC_CARRIED', 'LOC_WORN', 'LOC_NOT_CREATED', 'LOC_HERE',
    'MAX_OBJECT', 'MAX_LOCATION', 'NO_OBJECT', 'MAX_FLAG_VALUE',
    'FCARRIED', 'FOBJECTS_CONVEYABLE', 'FPLAYER', 'FPLAYER_STRENGTH', 'FVERB',
    'OFUSCATE_VALUE',
    'SM23', 'SM25', 'SM26', 'SM27', 'SM36', 'SM38', 'SM41', 'SM42', 'SM43', 'SM50',
];
vm.runInContext(NEEDED_CONSTANTS.map(n => `this.${n} = ${n};`).join('\n'), sandbox);

const flags = sandbox.flags;
const objects = sandbox.objects;
const DDB = sandbox.DDB;
const {
    NO_WORD, LOC_CARRIED, LOC_WORN, LOC_NOT_CREATED, LOC_HERE,
    MAX_OBJECT, MAX_LOCATION,
    FCARRIED, FOBJECTS_CONVEYABLE, FPLAYER, FPLAYER_STRENGTH,
    OFUSCATE_VALUE,
    SM23, SM25, SM26, SM27, SM36, SM38, SM41, SM42, SM43, SM50,
} = sandbox;

// Condact routines are plain top-level `function` declarations in jdaad.js,
// which (unlike `const`) *are* attached to the sandbox global object, so they
// can be destructured directly.
const {
    _AT, _NOTAT, _ATGT, _ATLT,
    _ZERO, _NOTZERO, _EQ, _GT, _LT, _NOTEQ, _SAME, _NOTSAME, _BIGGER, _SMALLER,
    _PRESENT, _ABSENT, _WORN, _NOTWORN, _CARRIED, _NOTCARR,
    _ISAT, _ISNOTAT, _CHANCE, _ISDONE, _ISNDONE,
    _SET, _CLEAR, _LET, _PLUS, _MINUS, _ADD, _SUB, _GOTO,
    _PLACE, _CREATE, _DESTROY, _SWAP,
    _COPYOF, _COPYFF, _COPYBF, _COPYOO, _COPYFO,
    _RANDOM, _WEIGH, _WEIGHT,
    _GET, _REMOVE,
} = sandbox;

// ============================================================================
// FRAMEWORK
// ============================================================================

let passCount = 0;
let failCount = 0;
let sectionFails = 0;

function Check(condition, testName) {
    if (condition) {
        passCount++;
        console.log('  PASS: ' + testName);
    } else {
        failCount++;
        sectionFails++;
        console.log('  FAIL: ' + testName);
    }
}

function Section(title) {
    sectionFails = 0;
    console.log('\n[' + title + ']');
}

function SectionEnd() {
    console.log(sectionFails === 0 ? '  (all passed)' : '  (' + sectionFails + ' failure(s))');
}

// ============================================================================
// TEST DDB
//
// Minimal DDB with 4 test objects (mirrors unittest.pas's TestDDB exactly):
//   Obj0 - at location 2,        noun=10, adj=255, weight=1
//   Obj1 - LOC_CARRIED (254),    noun=20, adj=255, weight=2
//   Obj2 - LOC_WORN    (253),    noun=30, adj=5,   weight=2, container+wearable
//   Obj3 - LOC_NOT_CREATED(252), noun=40, adj=255, weight=5
//
// Layout inside DDBDATA:
//   Offset 34  : initial locations (4 bytes)
//   Offset 38  : noun+adj pairs    (8 bytes)
//   Offset 46  : weight/cont/wear  (4 bytes)
//   Offset 50  : attributes        (8 bytes, all zero)
//   Offset 58  : sysmess pointer table (word per message#, 0..50)
//   Offset 160 : shared sysmess text ("OK" + terminator, 3 bytes)
//
// Any condact that prints a system message (GET, REMOVE...) calls Sysmess(),
// which indexes the pointer table by message number. Every message number
// actually reachable by the condacts under test (_GET, _REMOVE) points at the
// same 3-byte placeholder text; assertions never check printed text, only
// flag/object state, so the placeholder's exact wording doesn't matter - it
// deliberately contains no '_' (object-name escape) since objectPos isn't
// populated either.
// ============================================================================

const TEST_NUM_OBJ = 4;
const TEST_NUM_LOC = 5;
const SYSMESS_TABLE_POS = 58;
const SYSMESS_TEXT_POS = 160;

// Every system message _GET or _REMOVE can print, across all their branches.
const REACHABLE_SYSMESS = [SM23, SM25, SM26, SM27, SM36, SM38, SM41, SM42, SM43, SM50];

function setSysmessEntry(msgNum) {
    const p = SYSMESS_TABLE_POS + 2 * msgNum;
    sandbox.DDBDATA[p] = SYSMESS_TEXT_POS & 0xFF;
    sandbox.DDBDATA[p + 1] = (SYSMESS_TEXT_POS >> 8) & 0xFF;
}

function initTestDDB() {
    sandbox.DDBDATA.fill(0);

    // Initial locations (offset 34)
    sandbox.DDBDATA[34] = 2;
    sandbox.DDBDATA[35] = LOC_CARRIED;
    sandbox.DDBDATA[36] = LOC_WORN;
    sandbox.DDBDATA[37] = LOC_NOT_CREATED;

    // Noun + adj (offset 38)
    sandbox.DDBDATA[38] = 10; sandbox.DDBDATA[39] = NO_WORD;
    sandbox.DDBDATA[40] = 20; sandbox.DDBDATA[41] = NO_WORD;
    sandbox.DDBDATA[42] = 30; sandbox.DDBDATA[43] = 5;
    sandbox.DDBDATA[44] = 40; sandbox.DDBDATA[45] = NO_WORD;

    // Weight / container / wearable (offset 46)
    sandbox.DDBDATA[46] = 1;    // Obj0: weight=1
    sandbox.DDBDATA[47] = 2;    // Obj1: weight=2
    sandbox.DDBDATA[48] = 0xC2; // Obj2: wearable(0x80)+container(0x40)+weight=2
    sandbox.DDBDATA[49] = 5;    // Obj3: weight=5

    // Attributes (offset 50) - all zero, already from .fill(0)

    // Shared placeholder sysmess text: 'O','K' obfuscated (byte XOR 0xFF),
    // terminated by (0x0A xor 0xFF), matching getMessageInternal's encoding.
    sandbox.DDBDATA[SYSMESS_TEXT_POS] = 'O'.charCodeAt(0) ^ OFUSCATE_VALUE;
    sandbox.DDBDATA[SYSMESS_TEXT_POS + 1] = 'K'.charCodeAt(0) ^ OFUSCATE_VALUE;
    sandbox.DDBDATA[SYSMESS_TEXT_POS + 2] = 0x0A ^ OFUSCATE_VALUE;

    REACHABLE_SYSMESS.forEach(setSysmessEntry);

    const h = DDB.header;
    h.version = 2;
    h.targetMachineLanguage = 0;
    h.the95 = 0;
    h.numObj = TEST_NUM_OBJ;
    h.numLoc = TEST_NUM_LOC;
    h.numMsg = 0;
    h.numSys = 51;
    h.numPro = 1;
    h.tokenPos = 0;
    h.processPos = 0;
    h.objectPos = 0;
    h.locationPos = 0;
    h.messagePos = 0;
    h.sysmessPos = SYSMESS_TABLE_POS;
    h.connectionPos = 0;
    h.vocabularyPos = 0;
    h.objInitiallyAtPos = 34;
    h.objNamePos = 38;
    h.objWeightContWearPos = 46;
    h.objAttributesPos = 50;
    h.fileLength = sandbox.DDBDATA.length;

    DDB.entryPTR = 0;
    DDB.condactPTR = 0;
    DDB.processPTR = 0;
    DDB.doallPTR = 0;
}

function ResetState() {
    flags.resetFlags();
    objects.resetObjects();
    flags.setFlag(FPLAYER, 3);
    flags.setFlag(FOBJECTS_CONVEYABLE, 5);
    flags.setFlag(FPLAYER_STRENGTH, 50);
    sandbox.done = false;
    sandbox.condactResult = true;
    DDB.entryPTR = 0;
    DDB.condactPTR = 0;
}

// ============================================================================
// FLAG TESTS
// ============================================================================

function RunFlagTests() {
    Section('FLAGS - get/set');
    flags.resetFlags();

    flags.setFlag(0, 42);
    Check(flags.getFlag(0) === 42, 'setFlag/getFlag (flag 0 = 42)');

    flags.setFlag(255, 255);
    Check(flags.getFlag(255) === 255, 'setFlag/getFlag boundary (flag 255 = 255)');

    flags.setFlag(128, 0);
    Check(flags.getFlag(128) === 0, 'setFlag to 0');

    flags.setFlag(sandbox.FVERB, 77);
    Check(flags.getFlag(33) === 77, 'setFlag uses named constant FVERB=33');

    {
        let ok = true;
        for (let i = 0; i <= 255; i++) {
            flags.setFlag(i, i);
            if (flags.getFlag(i) !== i) ok = false;
        }
        Check(ok, 'all 256 flags round-trip correctly');
    }
    SectionEnd();

    Section('FLAGS - bit operations');
    flags.resetFlags();

    flags.setFlag(10, 0);
    flags.setFlagBit(10, 0);
    Check(flags.getFlag(10) === 1, 'setFlagBit bit 0');

    flags.setFlag(10, 0);
    flags.setFlagBit(10, 7);
    Check(flags.getFlag(10) === 128, 'setFlagBit bit 7');

    flags.setFlag(10, 0xFF);
    flags.clearFlagBit(10, 0);
    Check(flags.getFlag(10) === 0xFE, 'clearFlagBit bit 0');

    flags.setFlag(10, 0xFF);
    flags.clearFlagBit(10, 7);
    Check(flags.getFlag(10) === 0x7F, 'clearFlagBit bit 7');

    flags.setFlag(10, 0);
    flags.toggleFlagBit(10, 3);
    Check(flags.getFlag(10) === 8, 'toggleFlagBit sets bit 3');
    flags.toggleFlagBit(10, 3);
    Check(flags.getFlag(10) === 0, 'toggleFlagBit clears bit 3');

    flags.setFlag(10, 0x55);
    Check(flags.getFlagBit(10, 0) === true, 'getFlagBit: bit 0 of 0x55 is set');
    Check(flags.getFlagBit(10, 1) === false, 'getFlagBit: bit 1 of 0x55 is clear');
    Check(flags.getFlagBit(10, 6) === true, 'getFlagBit: bit 6 of 0x55 is set');
    Check(flags.getFlagBit(10, 7) === false, 'getFlagBit: bit 7 of 0x55 is clear');
    SectionEnd();

    Section('FLAGS - resetFlags');
    flags.setFlag(5, 100); flags.setFlag(200, 200);
    flags.resetFlags();
    {
        let ok = true;
        for (let i = 0; i <= 255; i++) if (flags.getFlag(i) !== 0) ok = false;
        Check(ok, 'resetFlags zeroes all 256 flags');
    }
    SectionEnd();

    Section('FLAGS - RAM save/load');
    flags.resetFlags();
    flags.setFlag(0, 10); flags.setFlag(1, 20); flags.setFlag(50, 99);
    flags.RAMSAVEFlags();
    flags.setFlag(0, 0); flags.setFlag(1, 0); flags.setFlag(50, 0);
    flags.RAMLOADFlags(255);
    Check(flags.getFlag(0) === 10, 'RAMLoadFlags 255: flag 0 restored');
    Check(flags.getFlag(1) === 20, 'RAMLoadFlags 255: flag 1 restored');
    Check(flags.getFlag(50) === 99, 'RAMLoadFlags 255: flag 50 restored');

    // Partial restore. Per the DAAD spec ("the parameter specifies the LAST
    // flag to be reloaded"), RAMLOAD 1 must restore flags 0 AND 1, not just 0.
    flags.setFlag(0, 99); flags.setFlag(1, 99); flags.setFlag(2, 99);
    flags.RAMSAVEFlags();
    flags.setFlag(0, 0); flags.setFlag(1, 0); flags.setFlag(2, 0);
    flags.RAMLOADFlags(1);
    Check(flags.getFlag(0) === 99, 'RAMLoadFlags 1: flag 0 restored');
    Check(flags.getFlag(1) === 99, 'RAMLoadFlags 1: flag 1 restored');
    Check(flags.getFlag(2) === 0, 'RAMLoadFlags 1: flag 2 NOT restored');
    SectionEnd();
}

// ============================================================================
// OBJECT TESTS
// ============================================================================

function RunObjectTests() {
    Section('OBJECTS - location get/set');
    objects.setObjectLocation(0, 2);
    objects.setObjectLocation(1, LOC_CARRIED);
    objects.setObjectLocation(2, LOC_WORN);
    objects.setObjectLocation(3, LOC_NOT_CREATED);
    Check(objects.getObjectLocation(0) === 2, 'Obj0 at loc 2');
    Check(objects.getObjectLocation(1) === LOC_CARRIED, 'Obj1 carried');
    Check(objects.getObjectLocation(2) === LOC_WORN, 'Obj2 worn');
    Check(objects.getObjectLocation(3) === LOC_NOT_CREATED, 'Obj3 not created');
    SectionEnd();

    Section('OBJECTS - resetObjects');
    ResetState();
    Check(objects.getObjectLocation(0) === 2, 'resetObjects: Obj0 at initial loc 2');
    Check(objects.getObjectLocation(1) === LOC_CARRIED, 'resetObjects: Obj1 initially carried');
    Check(objects.getObjectLocation(2) === LOC_WORN, 'resetObjects: Obj2 initially worn');
    Check(objects.getObjectLocation(3) === LOC_NOT_CREATED, 'resetObjects: Obj3 initially not created');
    Check(flags.getFlag(FCARRIED) === 1, 'resetObjects: FCARRIED=1 (only Obj1 counts, not worn Obj2)');
    SectionEnd();

    Section('OBJECTS - getObjectCountAt');
    ResetState();
    objects.setObjectLocation(0, 5); objects.setObjectLocation(1, 5);
    objects.setObjectLocation(2, 5); objects.setObjectLocation(3, 7);
    Check(objects.getObjectCountAt(5) === 3, '3 objects at loc 5');
    Check(objects.getObjectCountAt(7) === 1, '1 object at loc 7');
    Check(objects.getObjectCountAt(0) === 0, '0 objects at loc 0');
    SectionEnd();

    Section('OBJECTS - getNextObjectAt');
    ResetState();
    objects.setObjectLocation(0, 5); objects.setObjectLocation(1, 7);
    objects.setObjectLocation(2, 5); objects.setObjectLocation(3, 5);
    Check(objects.getNextObjectAt(-1, 5) === 0, 'first object at loc 5 is Obj0');
    Check(objects.getNextObjectAt(0, 5) === 2, 'next after Obj0 at loc 5 is Obj2');
    Check(objects.getNextObjectAt(2, 5) === 3, 'next after Obj2 at loc 5 is Obj3');
    Check(objects.getNextObjectAt(3, 5) === MAX_OBJECT, 'no more at loc 5 after Obj3');
    Check(objects.getNextObjectAt(-1, 9) === MAX_OBJECT, 'nothing at empty loc 9');
    SectionEnd();

    Section('OBJECTS - weight/container/wearable');
    ResetState();
    Check(objects.getObjectWeight(0) === 1, 'Obj0 weight=1');
    Check(objects.getObjectWeight(1) === 2, 'Obj1 weight=2');
    Check(objects.getObjectWeight(2) === 2, 'Obj2 weight=2 (low 6 bits of 0xC2)');
    Check(objects.getObjectWeight(3) === 5, 'Obj3 weight=5');
    Check(!!objects.isObjectWearable(2) === true, 'Obj2 is wearable');
    Check(!!objects.isObjectWearable(0) === false, 'Obj0 is not wearable');
    Check(!!objects.isObjectContainer(2) === true, 'Obj2 is container');
    Check(!!objects.isObjectContainer(1) === false, 'Obj1 is not container');
    SectionEnd();

    Section('OBJECTS - getObjectFullWeight (containers)');
    ResetState();
    // Put Obj0 (w=1) and Obj1 (w=2) inside container Obj2 (w=2)
    objects.setObjectLocation(0, 2);
    objects.setObjectLocation(1, 2);
    Check(objects.getObjectFullWeight(2) === 5, 'container Obj2: own(2)+Obj0(1)+Obj1(2)=5');
    Check(objects.getObjectFullWeight(0) === 1, 'non-container Obj0=1');
    Check(objects.getObjectFullWeight(3) === 5, 'non-container Obj3=5');
    SectionEnd();

    Section('OBJECTS - getObjectByVocabularyAtLocation');
    ResetState();
    objects.setObjectLocation(0, 3); objects.setObjectLocation(1, 3);
    objects.setObjectLocation(2, 3); objects.setObjectLocation(3, 7);
    Check(objects.getObjectByVocabularyAtLocation(10, NO_WORD, 3) === 0, 'noun=10 at loc 3 -> Obj0');
    Check(objects.getObjectByVocabularyAtLocation(20, NO_WORD, 3) === 1, 'noun=20 at loc 3 -> Obj1');
    Check(objects.getObjectByVocabularyAtLocation(30, 5, 3) === 2, 'noun=30 adj=5 at loc 3 -> Obj2');
    Check(objects.getObjectByVocabularyAtLocation(40, NO_WORD, 3) === MAX_OBJECT, 'noun=40 NOT at loc 3 -> not found');
    Check(objects.getObjectByVocabularyAtLocation(40, NO_WORD, 7) === 3, 'noun=40 at loc 7 -> Obj3');
    Check(objects.getObjectByVocabularyAtLocation(99, NO_WORD, 3) === MAX_OBJECT, 'unknown noun -> not found');
    // Partial match: typed noun only, object has adjective
    Check(objects.getObjectByVocabularyAtLocation(30, NO_WORD, 3) === 2, 'partial match noun=30 adj=any -> Obj2');
    // Any-location search
    Check(objects.getObjectByVocabularyAtLocation(40, NO_WORD, MAX_LOCATION) === 3, 'MAX_LOCATION finds Obj3 regardless of location');
    SectionEnd();

    Section('OBJECTS - RAM save/load');
    ResetState();
    objects.setObjectLocation(0, 10); objects.setObjectLocation(1, 11);
    objects.RAMSAVEObjects();
    objects.setObjectLocation(0, 20); objects.setObjectLocation(1, 20);
    objects.RAMLOADObjects();
    Check(objects.getObjectLocation(0) === 10, 'RAMLoadObjects: Obj0 restored to 10');
    Check(objects.getObjectLocation(1) === 11, 'RAMLoadObjects: Obj1 restored to 11');
    SectionEnd();
}

// ============================================================================
// CONDITION CONDACT TESTS
// ============================================================================

function RunConditionTests() {
    Section('CONDACTS - AT / NOTAT / ATGT / ATLT');
    ResetState();
    flags.setFlag(FPLAYER, 5);

    sandbox.Parameter1 = 5; _AT(); Check(sandbox.condactResult === true, '_AT:   player=5  param=5 -> true');
    sandbox.Parameter1 = 3; _AT(); Check(sandbox.condactResult === false, '_AT:   player=5  param=3 -> false');
    sandbox.Parameter1 = 3; _NOTAT(); Check(sandbox.condactResult === true, '_NOTAT: player=5  param=3 -> true');
    sandbox.Parameter1 = 5; _NOTAT(); Check(sandbox.condactResult === false, '_NOTAT: player=5  param=5 -> false');
    sandbox.Parameter1 = 4; _ATGT(); Check(sandbox.condactResult === true, '_ATGT: 5>4 -> true');
    sandbox.Parameter1 = 5; _ATGT(); Check(sandbox.condactResult === false, '_ATGT: 5>5 -> false');
    sandbox.Parameter1 = 6; _ATLT(); Check(sandbox.condactResult === true, '_ATLT: 5<6 -> true');
    sandbox.Parameter1 = 5; _ATLT(); Check(sandbox.condactResult === false, '_ATLT: 5<5 -> false');
    SectionEnd();

    Section('CONDACTS - ZERO / NOTZERO / EQ / GT / LT / NOTEQ / SAME / NOTSAME / BIGGER / SMALLER');
    ResetState();
    flags.setFlag(10, 0);
    sandbox.Parameter1 = 10; _ZERO(); Check(sandbox.condactResult === true, '_ZERO:    flag=0 -> true');
    flags.setFlag(10, 1);
    _ZERO(); Check(sandbox.condactResult === false, '_ZERO:    flag=1 -> false');

    flags.setFlag(10, 5);
    sandbox.Parameter1 = 10; _NOTZERO(); Check(sandbox.condactResult === true, '_NOTZERO: flag=5 -> true');
    flags.setFlag(10, 0);
    _NOTZERO(); Check(sandbox.condactResult === false, '_NOTZERO: flag=0 -> false');

    flags.setFlag(10, 42);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 42; _EQ(); Check(sandbox.condactResult === true, '_EQ:   42=42 -> true');
    sandbox.Parameter2 = 41; _EQ(); Check(sandbox.condactResult === false, '_EQ:   42=41 -> false');

    sandbox.Parameter1 = 10; sandbox.Parameter2 = 41; _GT(); Check(sandbox.condactResult === true, '_GT:   42>41 -> true');
    sandbox.Parameter2 = 42; _GT(); Check(sandbox.condactResult === false, '_GT:   42>42 -> false');

    sandbox.Parameter1 = 10; sandbox.Parameter2 = 43; _LT(); Check(sandbox.condactResult === true, '_LT:   42<43 -> true');
    sandbox.Parameter2 = 42; _LT(); Check(sandbox.condactResult === false, '_LT:   42<42 -> false');

    sandbox.Parameter1 = 10; sandbox.Parameter2 = 99; _NOTEQ(); Check(sandbox.condactResult === true, '_NOTEQ: 42<>99 -> true');
    sandbox.Parameter2 = 42; _NOTEQ(); Check(sandbox.condactResult === false, '_NOTEQ: 42<>42 -> false');

    flags.setFlag(10, 7); flags.setFlag(11, 7);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _SAME(); Check(sandbox.condactResult === true, '_SAME:    7=7 -> true');
    flags.setFlag(11, 8);
    _SAME(); Check(sandbox.condactResult === false, '_SAME:    7<>8 -> false');

    flags.setFlag(11, 8);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _NOTSAME(); Check(sandbox.condactResult === true, '_NOTSAME: 7<>8 -> true');
    flags.setFlag(11, 7);
    _NOTSAME(); Check(sandbox.condactResult === false, '_NOTSAME: 7=7 -> false');

    flags.setFlag(10, 10); flags.setFlag(11, 5);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _BIGGER(); Check(sandbox.condactResult === true, '_BIGGER:  10>5 -> true');
    flags.setFlag(10, 5);
    _BIGGER(); Check(sandbox.condactResult === false, '_BIGGER:  5=5 -> false');

    flags.setFlag(10, 3); flags.setFlag(11, 9);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _SMALLER(); Check(sandbox.condactResult === true, '_SMALLER: 3<9 -> true');
    flags.setFlag(10, 9);
    _SMALLER(); Check(sandbox.condactResult === false, '_SMALLER: 9=9 -> false');
    SectionEnd();

    Section('CONDACTS - PRESENT / ABSENT / WORN / NOTWORN / CARRIED / NOTCARR');
    ResetState();
    flags.setFlag(FPLAYER, 3);
    objects.setObjectLocation(0, 3);          // at player location
    objects.setObjectLocation(1, LOC_CARRIED);
    objects.setObjectLocation(2, LOC_WORN);
    objects.setObjectLocation(3, LOC_NOT_CREATED);

    sandbox.Parameter1 = 0; _PRESENT(); Check(sandbox.condactResult === true, '_PRESENT: at loc -> true');
    sandbox.Parameter1 = 1; _PRESENT(); Check(sandbox.condactResult === true, '_PRESENT: carried -> true');
    sandbox.Parameter1 = 2; _PRESENT(); Check(sandbox.condactResult === true, '_PRESENT: worn -> true');
    sandbox.Parameter1 = 3; _PRESENT(); Check(sandbox.condactResult === false, '_PRESENT: not created -> false');

    sandbox.Parameter1 = 3; _ABSENT(); Check(sandbox.condactResult === true, '_ABSENT: not created -> true');
    sandbox.Parameter1 = 0; _ABSENT(); Check(sandbox.condactResult === false, '_ABSENT: at loc -> false');

    sandbox.Parameter1 = 2; _WORN(); Check(sandbox.condactResult === true, '_WORN: Obj2 worn -> true');
    sandbox.Parameter1 = 1; _WORN(); Check(sandbox.condactResult === false, '_WORN: Obj1 carried not worn -> false');
    sandbox.Parameter1 = 1; _NOTWORN(); Check(sandbox.condactResult === true, '_NOTWORN: carried not worn -> true');
    sandbox.Parameter1 = 2; _NOTWORN(); Check(sandbox.condactResult === false, '_NOTWORN: worn -> false');

    sandbox.Parameter1 = 1; _CARRIED(); Check(sandbox.condactResult === true, '_CARRIED: Obj1 carried -> true');
    sandbox.Parameter1 = 2; _CARRIED(); Check(sandbox.condactResult === false, '_CARRIED: worn not carried -> false');
    sandbox.Parameter1 = 2; _NOTCARR(); Check(sandbox.condactResult === true, '_NOTCARR: worn -> true');
    sandbox.Parameter1 = 1; _NOTCARR(); Check(sandbox.condactResult === false, '_NOTCARR: carried -> false');
    SectionEnd();

    Section('CONDACTS - ISAT / ISNOTAT');
    ResetState();
    flags.setFlag(FPLAYER, 3);
    objects.setObjectLocation(0, 7);

    sandbox.Parameter1 = 0; sandbox.Parameter2 = 7; _ISAT();
    Check(sandbox.condactResult === true, '_ISAT: Obj0 at 7, param2=7 -> true');
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 5; _ISAT();
    Check(sandbox.condactResult === false, '_ISAT: Obj0 at 7, param2=5 -> false');
    // LOC_HERE substitution
    objects.setObjectLocation(0, 3);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = LOC_HERE; _ISAT();
    Check(sandbox.condactResult === true, '_ISAT: LOC_HERE resolves to FPLAYER=3, Obj0 at 3 -> true');

    objects.setObjectLocation(0, 7);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 7; _ISNOTAT();
    Check(sandbox.condactResult === false, '_ISNOTAT: Obj0 at 7, param2=7 -> false');
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 5; _ISNOTAT();
    Check(sandbox.condactResult === true, '_ISNOTAT: Obj0 at 7, param2=5 -> true');
    SectionEnd();

    Section('CONDACTS - CHANCE');
    sandbox.Parameter1 = 100; _CHANCE(); Check(sandbox.condactResult === true, '_CHANCE 100 always succeeds');
    sandbox.Parameter1 = 101; _CHANCE(); Check(sandbox.condactResult === false, '_CHANCE 101 (>100) always fails');
    SectionEnd();

    Section('CONDACTS - ISDONE / ISNDONE');
    sandbox.done = true;
    _ISDONE(); Check(sandbox.condactResult === true, '_ISDONE:  Done=true  -> true');
    _ISNDONE(); Check(sandbox.condactResult === false, '_ISNDONE: Done=true  -> false');
    sandbox.done = false;
    _ISDONE(); Check(sandbox.condactResult === false, '_ISDONE:  Done=false -> false');
    _ISNDONE(); Check(sandbox.condactResult === true, '_ISNDONE: Done=false -> true');
    SectionEnd();
}

// ============================================================================
// ACTION CONDACT TESTS
// ============================================================================

function RunActionTests() {
    Section('CONDACTS - SET / CLEAR / LET / PLUS / MINUS');
    ResetState();

    sandbox.Parameter1 = 20; _SET();
    Check(flags.getFlag(20) === 255, '_SET: flag 20 = MAX (255)');
    Check(sandbox.done === true, '_SET: sets done');

    sandbox.Parameter1 = 20; _CLEAR();
    Check(flags.getFlag(20) === 0, '_CLEAR: flag 20 = 0');

    sandbox.Parameter1 = 20; sandbox.Parameter2 = 77; _LET();
    Check(flags.getFlag(20) === 77, '_LET: flag 20 = 77');

    flags.setFlag(20, 10); sandbox.Parameter1 = 20; sandbox.Parameter2 = 5; _PLUS();
    Check(flags.getFlag(20) === 15, '_PLUS: 10+5=15');
    flags.setFlag(20, 250); sandbox.Parameter2 = 10; _PLUS();
    Check(flags.getFlag(20) === 255, '_PLUS: overflow clamps to 255');

    flags.setFlag(20, 20); sandbox.Parameter1 = 20; sandbox.Parameter2 = 8; _MINUS();
    Check(flags.getFlag(20) === 12, '_MINUS: 20-8=12');
    flags.setFlag(20, 5); sandbox.Parameter2 = 10; _MINUS();
    Check(flags.getFlag(20) === 0, '_MINUS: underflow clamps to 0');
    SectionEnd();

    Section('CONDACTS - ADD / SUB');
    ResetState();
    flags.setFlag(10, 30); flags.setFlag(11, 20);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _ADD();
    Check(flags.getFlag(11) === 50, '_ADD: flag11(20) += flag10(30) = 50');
    flags.setFlag(10, 200); flags.setFlag(11, 200);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _ADD();
    Check(flags.getFlag(11) === 255, '_ADD: overflow clamps to 255');

    flags.setFlag(10, 5); flags.setFlag(11, 20);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _SUB();
    Check(flags.getFlag(11) === 15, '_SUB: flag11(20) -= flag10(5) = 15');
    flags.setFlag(10, 30); flags.setFlag(11, 10);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _SUB();
    Check(flags.getFlag(11) === 0, '_SUB: underflow clamps to 0');
    SectionEnd();

    Section('CONDACTS - GOTO');
    ResetState();
    flags.setFlag(FPLAYER, 3);
    sandbox.Parameter1 = 7; _GOTO();
    Check(flags.getFlag(FPLAYER) === 7, '_GOTO: player moved to 7');
    Check(sandbox.done === true, '_GOTO: sets done');
    SectionEnd();

    Section('CONDACTS - PLACE / CREATE / DESTROY / SWAP');
    ResetState();
    flags.setFlag(FCARRIED, 1);
    objects.setObjectLocation(0, 5);
    objects.setObjectLocation(1, LOC_CARRIED);

    // PLACE non-carried to another location
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 9; _PLACE();
    Check(objects.getObjectLocation(0) === 9, '_PLACE: Obj0 moved to loc 9');
    Check(flags.getFlag(FCARRIED) === 1, '_PLACE: FCARRIED unchanged (Obj0 not carried)');

    // PLACE from CARRIED -> FCARRIED decrements
    sandbox.Parameter1 = 1; sandbox.Parameter2 = 5; _PLACE();
    Check(objects.getObjectLocation(1) === 5, '_PLACE from CARRIED: Obj1 at loc 5');
    Check(flags.getFlag(FCARRIED) === 0, '_PLACE from CARRIED: FCARRIED decremented');

    // PLACE to CARRIED -> FCARRIED increments
    sandbox.Parameter1 = 0; sandbox.Parameter2 = LOC_CARRIED; _PLACE();
    Check(objects.getObjectLocation(0) === LOC_CARRIED, '_PLACE to CARRIED: Obj0 now carried');
    Check(flags.getFlag(FCARRIED) === 1, '_PLACE to CARRIED: FCARRIED incremented');

    // PLACE with LOC_HERE
    flags.setFlag(FPLAYER, 4);
    sandbox.Parameter1 = 1; sandbox.Parameter2 = LOC_HERE; _PLACE();
    Check(objects.getObjectLocation(1) === 4, '_PLACE LOC_HERE resolves to FPLAYER=4');

    // CREATE
    ResetState();
    flags.setFlag(FPLAYER, 6);
    objects.setObjectLocation(3, LOC_NOT_CREATED);
    sandbox.Parameter1 = 3; _CREATE();
    Check(objects.getObjectLocation(3) === 6, '_CREATE: Obj3 placed at player loc 6');

    // DESTROY
    sandbox.Parameter1 = 3; _DESTROY();
    Check(objects.getObjectLocation(3) === LOC_NOT_CREATED, '_DESTROY: Obj3 moved to LOC_NOT_CREATED');

    // SWAP
    objects.setObjectLocation(0, 10); objects.setObjectLocation(1, 20);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 1; _SWAP();
    Check(objects.getObjectLocation(0) === 20, '_SWAP: Obj0 now at 20');
    Check(objects.getObjectLocation(1) === 10, '_SWAP: Obj1 now at 10');
    SectionEnd();

    Section('CONDACTS - COPYOF / COPYFF / COPYBF / COPYOO / COPYFO');
    ResetState();
    objects.setObjectLocation(0, 7);

    sandbox.Parameter1 = 0; sandbox.Parameter2 = 15; _COPYOF();
    Check(flags.getFlag(15) === 7, '_COPYOF: flag 15 = Obj0 location (7)');

    flags.setFlag(10, 42);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 20; _COPYFF();
    Check(flags.getFlag(20) === 42, '_COPYFF: flag 20 = flag 10 (42)');

    flags.setFlag(10, 0); flags.setFlag(11, 99);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 11; _COPYBF();
    Check(flags.getFlag(10) === 99, '_COPYBF: flag 10 = flag 11 (99)');

    objects.setObjectLocation(0, 5); objects.setObjectLocation(1, 3);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 1; _COPYOO();
    Check(objects.getObjectLocation(1) === 5, '_COPYOO: Obj1 placed at Obj0 location (5)');

    flags.setFlag(10, 8);
    sandbox.Parameter1 = 10; sandbox.Parameter2 = 2; _COPYFO();
    Check(objects.getObjectLocation(2) === 8, '_COPYFO: Obj2 placed at location in flag 10 (8)');
    SectionEnd();

    Section('CONDACTS - RANDOM / WEIGH / WEIGHT');
    ResetState();
    sandbox.Parameter1 = 20; _RANDOM();
    Check(flags.getFlag(20) >= 1 && flags.getFlag(20) <= 100, '_RANDOM: result in 1..100');

    objects.setObjectLocation(0, 5);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 15; _WEIGH();
    Check(flags.getFlag(15) === 1, '_WEIGH: flag 15 = Obj0 weight (1)');
    sandbox.Parameter1 = 3; sandbox.Parameter2 = 15; _WEIGH();
    Check(flags.getFlag(15) === 5, '_WEIGH: flag 15 = Obj3 weight (5)');

    objects.setObjectLocation(0, LOC_CARRIED);
    objects.setObjectLocation(1, LOC_WORN);
    objects.setObjectLocation(2, LOC_NOT_CREATED);
    objects.setObjectLocation(3, LOC_NOT_CREATED);
    sandbox.Parameter1 = 20; _WEIGHT();
    Check(flags.getFlag(20) === 3, '_WEIGHT: carried Obj0(1) + worn Obj1(2) = 3');
    SectionEnd();
}

// ============================================================================
// BUG REGRESSION TESTS
// ============================================================================

function RunBugTests() {
    Section('REGRESSION - BUG#1: _REMOVE used FPLAYER instead of FCARRIED');
    // Old code: if getFlag(FPLAYER) >= getFlag(FOBJECTS_CONVEYABLE)
    // This compared room number to max-carry, so REMOVE blocked based on
    // which room you were in, not how full your hands were.
    // Fix: use FCARRIED.

    // Case 1: hands empty (FCARRIED=0), player at room 10, max=5.
    // Old: 10 >= 5 = true  -> wrongly blocked.
    // New: 0  >= 5 = false -> correctly allowed.
    ResetState();
    flags.setFlag(FPLAYER, 10);
    flags.setFlag(FOBJECTS_CONVEYABLE, 5);
    flags.setFlag(FCARRIED, 0);
    objects.setObjectLocation(2, LOC_WORN); // Obj2 is wearable
    sandbox.Parameter1 = 2; sandbox.done = false;
    _REMOVE();
    Check(objects.getObjectLocation(2) === LOC_CARRIED,
        'BUG#1 fixed: REMOVE with FCARRIED=0 moves worn item to carried');
    Check(flags.getFlag(FCARRIED) === 1,
        'BUG#1 fixed: FCARRIED incremented after successful REMOVE');

    // Case 2: hands truly full (FCARRIED=2 >= FOBJECTS_CONVEYABLE=2).
    // REMOVE must still be blocked.
    ResetState();
    flags.setFlag(FPLAYER, 1);
    flags.setFlag(FOBJECTS_CONVEYABLE, 2);
    flags.setFlag(FCARRIED, 2);
    objects.setObjectLocation(2, LOC_WORN);
    sandbox.Parameter1 = 2; sandbox.done = false;
    _REMOVE();
    Check(objects.getObjectLocation(2) === LOC_WORN,
        'BUG#1 verify: REMOVE blocked when FCARRIED >= FOBJECTS_CONVEYABLE');
    SectionEnd();

    Section('REGRESSION - GET capacity check (reference - was always correct)');
    ResetState();
    flags.setFlag(FPLAYER, 3);
    flags.setFlag(FCARRIED, 0);
    flags.setFlag(FOBJECTS_CONVEYABLE, 5);
    flags.setFlag(FPLAYER_STRENGTH, 50);
    objects.setObjectLocation(0, 3);
    sandbox.Parameter1 = 0; sandbox.done = false;
    _GET();
    Check(objects.getObjectLocation(0) === LOC_CARRIED, '_GET: Obj0 picked up');
    Check(flags.getFlag(FCARRIED) === 1, '_GET: FCARRIED incremented');

    ResetState();
    flags.setFlag(FPLAYER, 3);
    flags.setFlag(FCARRIED, 5);
    flags.setFlag(FOBJECTS_CONVEYABLE, 5);
    objects.setObjectLocation(0, 3);
    sandbox.Parameter1 = 0; sandbox.done = false;
    _GET();
    Check(objects.getObjectLocation(0) === 3, '_GET: blocked when FCARRIED >= FOBJECTS_CONVEYABLE');
    SectionEnd();

    Section('REGRESSION - PLACE FCARRIED accounting');
    ResetState();
    flags.setFlag(FCARRIED, 1);
    objects.setObjectLocation(0, LOC_CARRIED);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = 5; _PLACE();
    Check(flags.getFlag(FCARRIED) === 0,
        '_PLACE from CARRIED decrements FCARRIED (1->0)');

    flags.setFlag(FCARRIED, 0);
    objects.setObjectLocation(0, 7);
    sandbox.Parameter1 = 0; sandbox.Parameter2 = LOC_CARRIED; _PLACE();
    Check(flags.getFlag(FCARRIED) === 1,
        '_PLACE to CARRIED increments FCARRIED (0->1)');
    SectionEnd();
}

// ============================================================================
// MAIN
// ============================================================================

console.log('jDAAD Unit Tests (Node.js)');
console.log('===============================================');

initTestDDB();
ResetState();

RunFlagTests();
RunObjectTests();
RunConditionTests();
RunActionTests();
RunBugTests();

console.log();
console.log('===============================================');
console.log('Results: ' + passCount + ' passed, ' + failCount + ' failed.');
console.log(failCount === 0 ? 'ALL TESTS PASSED.' : 'SOME TESTS FAILED.');
console.log();

process.exitCode = failCount === 0 ? 0 : 1;
