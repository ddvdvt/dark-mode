// Loads the plain-script libraries (they publish themselves on globalThis.DarkModeLib).
import '../extension/lib/color.js';
import '../extension/lib/css-transform.js';
import '../extension/lib/settings.js';
import '../extension/lib/page-analysis.js';

/** @type {any} */
export const Lib = globalThis.DarkModeLib;

// ---- Fake CSSOM: just enough of CSSStyleRule & co. for lib/css-transform.js (dispatches on constructor.name)

export class FakeStyle {
  /** @param {Array<[string, string, string?]>} decls */
  constructor(decls) {
    this.decls = decls;
    decls.forEach(([p], i) => (this[i] = p));
    this.length = decls.length;
  }
  getPropertyValue(p) {
    const d = this.decls.find((x) => x[0] === p);
    return d ? d[1] : '';
  }
  getPropertyPriority(p) {
    const d = this.decls.find((x) => x[0] === p);
    return d && d[2] ? 'important' : '';
  }
}
export class CSSStyleRule {
  constructor(selectorText, decls, nested = []) {
    this.selectorText = selectorText;
    this.style = new FakeStyle(decls);
    this.cssRules = nested;
  }
}
export class CSSMediaRule {
  constructor(mediaText, rules) {
    this.media = { mediaText };
    this.cssRules = rules;
  }
}
export class CSSSupportsRule {
  constructor(conditionText, rules) {
    this.conditionText = conditionText;
    this.cssRules = rules;
  }
}
export class CSSLayerBlockRule {
  constructor(name, rules) {
    this.name = name;
    this.cssRules = rules;
  }
}
export class CSSContainerRule {
  constructor(cssText, rules) {
    this.cssText = cssText;
    this.cssRules = rules;
  }
}
export class CSSKeyframeRule {
  constructor(keyText, decls) {
    this.keyText = keyText;
    this.style = new FakeStyle(decls);
  }
}
export class CSSKeyframesRule {
  constructor(name, frames) {
    this.name = name;
    this.cssRules = frames;
  }
}
export class CSSImportRule {
  constructor(sheet, mediaText = '') {
    this.styleSheet = sheet;
    this.media = { mediaText };
  }
}
export class CSSFontFaceRule {
  constructor() {
    this.style = new FakeStyle([['src', 'url(a.woff)']]);
  }
}
export class CSSNestedDeclarations {
  constructor(decls) {
    this.style = new FakeStyle(decls);
  }
}
