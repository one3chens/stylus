/* global CodeMirror CSSLint stylelint linterConfig */
'use strict';

(() => {
  let config;

  CodeMirror.registerHelper('lint', 'csslint', (code, options, cm) =>
    copyOldIssues(cm, lintChangedRanges(cm, csslintOnRange))
  );

  CodeMirror.registerHelper('lint', 'stylelint', (code, options, cm) =>
    Promise.all(lintChangedRanges(cm, stylelintOnRange))
      .then(results => copyOldIssues(cm, results))
  );

  function csslintOnRange(range) {
    return CSSLint.verify(range.code, config).messages
      .map(item =>
        cookResult(
          range,
          item.line,
          item.col,
          item.message + ` (${item.rule.id})`,
          item.type
        )
      );
  }

  function stylelintOnRange(range) {
    return stylelint.lint({code: range.code, config})
      .then(({results}) => ((results[0] || {}).warnings || [])
        .map(item =>
          cookResult(
            range,
            item.line,
            item.column,
            item.text
              .replace('Unexpected ', '')
              .replace(/^./, firstLetter => firstLetter.toUpperCase()),
            item.severity
          )
        )
      );
  }

  function cookResult(range, line, col, message, severity) {
    line--;
    col--;
    const realL = line + range.from.line;
    const realC = col + (line === range.from.line ? range.from.ch : 0);
    return {
      from: CodeMirror.Pos(realL, realC),
      to: CodeMirror.Pos(realL, realC + 1),
      message,
      severity,
    };
  }

  function lintChangedRanges(cm, lintFunction) {
    // cache the config for subsequent *lintOnRange
    config = linterConfig.getCurrent();
    // the temp monkeypatch in updateLintReport() is there
    // only to allow sep=false that returns a line array
    const lines = cm.getValue(false);
    let ranges;
    if (!cm.stylusChanges) {
      // first run: lint everything
      ranges = [{
        code: lines.join('\n'),
        from: {line: 0, ch: 0},
        to: {line: lines.length - 1, ch: lines.last.length},
      }];
    } else {
      // sort by 'from' position in ascending order
      const changes = cm.stylusChanges.sort((a, b) => CodeMirror.cmpPos(a.from, b.from));
      // merge pass 1
      ranges = mergeRanges(changes);
      // extend up to previous } and down to next }
      for (const range of ranges) {
        const cursor = cm.getSearchCursor('}', range.from, {caseFold: false});
        range.from = cursor.findPrevious() && cursor.findPrevious()
          ? cursor.to()
          : {line: 0, ch: 0};
        range.to = cursor.findNext() && cursor.findNext() && cursor.findNext()
          ? cursor.to()
          : {line: lines.length - 1, ch: lines.last.length - 1};
      }
      // merge pass 2 on the extended ranges
      ranges = mergeRanges(ranges);
    }
    // fill the code and run lintFunction
    const results = [];
    for (const range of ranges) {
      range.code = cm.getRange(range.from, range.to);
      results.push(lintFunction(range));
    }
    // reset the changes queue and pass the ranges to updateLintReport
    (cm.stylusChanges || []).length = 0;
    cm.state.lint.changedRanges = ranges;
    return results;
  }

  function mergeRanges(sorted) {
    const ranges = [];
    let lastChange = {from: {}, to: {line: -1, ch: -1}};
    for (const change of sorted) {
      if (CodeMirror.cmpPos(change.from, change.to) > 0) {
        // straighten the inverted range
        const from = change.from;
        change.from = change.to;
        change.to = from;
      }
      if (CodeMirror.cmpPos(change.from, lastChange.to) > 0) {
        ranges.push({
          from: change.from,
          to: change.to,
          code: '',
        });
      } else if (CodeMirror.cmpPos(change.to, lastChange.to) > 0) {
        ranges[ranges.length - 1].to = change.to;
      }
      lastChange = change;
    }
    return ranges;
  }

  function copyOldIssues(cm, newAnns) {
    const oldMarkers = cm.state.lint.marked;
    let oldIndex = 0;
    let oldAnn = (oldMarkers[0] || {}).__annotation;

    const newRanges = cm.state.lint.changedRanges;
    let newIndex = 0;
    let newRange = newRanges[0];

    const finalAnns = [];
    const t0 = performance.now();
    while (oldAnn || newRange) {
      if (performance.now() - t0 > 500) {
        console.error('infinite loop canceled',
          JSON.stringify([
            newAnns,
            oldMarkers[0] && oldMarkers.map(m => ({from: m.__annotation.from, to: m.__annotation.to})),
            newRanges.map(r => Object.assign(r, {code: undefined}))
          ])
        );
        break;
      }
      // copy old issues prior to current newRange
      // eslint-disable-next-line no-unmodified-loop-condition
      while (oldAnn && (!newRange || CodeMirror.cmpPos(oldAnn.to, newRange.from) < 0)) {
        finalAnns.push(oldAnn);
        oldIndex++;
        oldAnn = (oldMarkers[oldIndex] || {}).__annotation;
      }
      // skip all old issues within newRange
      if (newRange) {
        while (oldAnn && CodeMirror.cmpPos(oldAnn.to, newRange.to) <= 0) {
          oldAnn = (oldMarkers[oldIndex++] || {}).__annotation;
        }
      }
      // copy all newRange prior to current oldAnn
      // eslint-disable-next-line no-unmodified-loop-condition
      while (newRange && (!oldAnn || CodeMirror.cmpPos(newRange.to, oldAnn.from) <= 0)) {
        finalAnns.push(...newAnns[newIndex]);
        newIndex++;
        newRange = newRanges[newIndex];
      }
    }
    return finalAnns;
  }
})();
