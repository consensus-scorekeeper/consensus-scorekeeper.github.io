// The RichDoc intermediate representation every packet format is adapted
// into before parsing. A RichDoc is a flat list of logical lines:
//
//   {
//     source: 'pdf' | 'docx' | 'txt' | 'test',
//     lines: [{
//       text,                       // trimmed plain text of the line
//       segments: [{ text, bold }], // rich runs; joined text must equal `text`
//       isBold,                     // line-level flag driving category detection
//       source: { page, y, lineNo } // provenance (page/y for PDFs, lineNo for .txt)
//     }]
//   }
//
// parseQuestions consumes a RichDoc directly; flattenDoc() below rebuilds the
// combined-string view (with a single space separating lines) that its
// position-based extraction works on. Adapters only ever build lines — they
// never deal in combined/posMap offsets.

export function makeLine(text, { segments = null, isBold = false, page = null, y = null, lineNo = null } = {}) {
  return {
    text,
    segments: segments || [{ text, bold: isBold }],
    isBold,
    source: { page, y, lineNo },
  };
}

// Flattens a RichDoc into the combined-string view parseQuestions extracts
// from:
//   combined           — all line texts joined by single spaces
//   segments           — [{ str, bold, page, y }] rich runs, with a non-bold
//                        ' ' separator between lines (carrying the preceding
//                        line's page/y)
//   posMap             — one { segIdx, charIdx } entry per char of `combined`
//   lineStartPositions — offset in `combined` where each line's text begins
export function flattenDoc(doc) {
  const segments = [];
  const lineStartPositions = [];
  let combined = '';

  doc.lines.forEach((line, i) => {
    if (i > 0) {
      const prev = doc.lines[i - 1].source;
      segments.push({ str: ' ', bold: false, page: prev.page ?? null, y: prev.y ?? null });
      combined += ' ';
    }
    lineStartPositions.push(combined.length);
    const runs = line.segments && line.segments.length ? line.segments : [{ text: line.text, bold: line.isBold }];
    for (const run of runs) {
      if (!run.text) continue;
      segments.push({ str: run.text, bold: !!run.bold, page: line.source.page ?? null, y: line.source.y ?? null });
      combined += run.text;
    }
  });

  const posMap = [];
  segments.forEach((seg, si) => {
    for (let ci = 0; ci < seg.str.length; ci++) posMap.push({ segIdx: si, charIdx: ci });
  });

  return { combined, segments, posMap, lineStartPositions };
}
