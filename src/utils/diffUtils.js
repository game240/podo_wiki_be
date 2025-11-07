const { compare, applyPatch } = require("fast-json-patch");
const { get: getByPointer } = require("jsonpointer");
const {
  diffChars,
  diffLines,
  diffWords,
  createTwoFilesPatch,
} = require("diff");
const countChars = require("./countChars");

function summarizeTextReplace(oldText, newText) {
  let added = 0,
    removed = 0;
  const diffs = diffChars(oldText, newText);
  diffs.forEach((p) => {
    if (p.added) {
      added += p.count || 0;
    }
    if (p.removed) {
      removed += p.count || 0;
    }
  });
  return { added, removed };
}

function summarizeDiffs(diffOps, previousDoc) {
  let added = 0,
    removed = 0,
    modified = 0;

  diffOps.forEach((op) => {
    switch (op.op) {
      case "add":
        if (op.value) {
          added += op.value.type === "image" ? 1 : countChars(op.value);
        }
        break;
      case "remove": {
        let oldNode =
          op.value ||
          (() => {
            try {
              return getByPointer(previousDoc, op.path);
            } catch {
              return null;
            }
          })();
        if (oldNode) {
          removed += oldNode.type === "image" ? 1 : countChars(oldNode);
        }
        break;
      }
      case "replace": {
        const oldText = (() => {
          try {
            return getByPointer(previousDoc, op.path);
          } catch {
            return "";
          }
        })();
        const { added: a, removed: r } = summarizeTextReplace(
          oldText,
          op.value
        );
        added += a;
        removed += r;
        break;
      }
    }
  });

  return { added, removed, modified };
}

// Tiptap(ProseMirror) JSON에서 텍스트만 추출하여 이어붙임
function extractTextFromPM(doc) {
  if (!doc) return "";
  const stack = [doc];
  let out = "";
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (typeof node === "object") {
      if (node.type === "text" && typeof node.text === "string") {
        out += node.text;
      }
      if (Array.isArray(node.content)) {
        for (let i = node.content.length - 1; i >= 0; i--) {
          stack.push(node.content[i]);
        }
      }
    } else if (typeof node === "string") {
      out += node;
    }
  }
  return out;
}

// 문자 단위 diff 기반으로 추가/삭제/교체(추정) 카운트
function countCharDelta(prevText, currText) {
  const parts = diffChars(prevText || "", currText || "");
  let added = 0,
    removed = 0;
  for (const p of parts) {
    if (p.added) added += p.value.length;
    else if (p.removed) removed += p.value.length;
  }
  const replacements = Math.min(added, removed);
  return { added, removed, replacements };
}

// Tiptap/일반 JSON/문자열 → 라인 비교용 텍스트
function docToText(doc) {
  if (doc == null) {
    return "";
  }
  if (typeof doc === "string") {
    return doc;
  }

  // Tiptap(ProseMirror) 문서처럼 보이면 평탄화
  if (
    doc &&
    typeof doc === "object" &&
    doc.type === "doc" &&
    Array.isArray(doc.content)
  ) {
    const lines = flattenPMDocToLines(doc);
    return lines.join("\n");
  }

  // 일반 JSON은 pretty-print
  try {
    return JSON.stringify(doc, null, 2);
  } catch {
    return String(doc);
  }
}

// Tiptap/ProseMirror 문서를 라인 배열로 평탄화
function flattenPMDocToLines(doc) {
  const lines = [];
  const walk = (node, ctx = {}) => {
    if (!node) return;

    switch (node.type) {
      case "doc":
      case "blockquote":
      case "bullet_list":
      case "ordered_list":
      case "list_item":
      case "table":
      case "table_row":
      case "table_cell":
      case "table_header":
        (node.content || []).forEach((c) => walk(c, ctx));
        break;

      case "heading": {
        const text = inlineText(node);
        lines.push(
          "#".repeat(Math.max(1, Math.min(6, node.attrs?.level || 1))) +
            " " +
            text
        );
        break;
      }

      case "paragraph": {
        const text = inlineText(node);
        // hardBreak 처리 포함 (inlineText에서 \n 생성)
        text.split("\n").forEach((ln) => lines.push(ln));
        break;
      }

      case "code_block": {
        const code = node.text || inlineText(node);
        const arr = String(code).split("\n");
        arr.forEach((ln) => lines.push(ln));
        break;
      }

      case "image": {
        const alt = node.attrs?.alt || "image";
        const src = node.attrs?.src || "";
        lines.push(`![${alt}](${src})`);
        break;
      }

      default: {
        // 기타 블록은 텍스트 추출 시도
        const text = inlineText(node);
        if (text) {
          text.split("\n").forEach((ln) => lines.push(ln));
        }
      }
    }
  };

  const inlineText = (node) => {
    if (!node) {
      return "";
    }
    if (node.type === "text") {
      return String(node.text || "");
    }
    if (!node.content) {
      return "";
    }

    const buf = [];
    for (const c of node.content) {
      if (c.type === "hardBreak") {
        buf.push("\n");
      } else if (c.type === "text") {
        buf.push(String(c.text || ""));
      } else {
        buf.push(inlineText(c));
      }
    }
    return buf.join("");
  };

  walk(doc);
  return lines;
}

// Git-like 라인 diff: equal/add/del/modify
function gitLikeDiff(oldText, newText, { withIntraLine = true } = {}) {
  const chunks = diffLines(oldText, newText);
  const ops = [];
  let oldLine = 1,
    newLine = 1;

  const splitLines = (v) => {
    const arr = v.split("\n");
    if (arr.length && arr[arr.length - 1] === "") {
      arr.pop();
    }
    return arr;
  };

  for (let i = 0; i < chunks.length; ++i) {
    const c = chunks[i];

    if (!c.added && !c.removed) {
      const lines = splitLines(c.value);
      ops.push({ type: "equal", oldStart: oldLine, newStart: newLine, lines });
      oldLine += lines.length;
      newLine += lines.length;
      continue;
    }

    if (c.removed && !c.added) {
      const delLines = splitLines(c.value);
      const next = chunks[i + 1];
      if (next && next.added && !next.removed) {
        const addLines = splitLines(next.value);

        let wordDiffs;
        if (withIntraLine) {
          const maxLen = Math.max(delLines.length, addLines.length);
          wordDiffs = [];
          for (let k = 0; k < maxLen; k++) {
            const a = delLines[k] ?? "";
            const b = addLines[k] ?? "";
            const parts = diffWords(a, b).map((p) => ({
              type: p.added ? "add" : p.removed ? "del" : "equal",
              text: p.value,
            }));
            wordDiffs.push(parts);
          }
        }

        ops.push({
          type: "modify",
          oldStart: oldLine,
          newStart: newLine,
          oldLines: delLines,
          newLines: addLines,
          wordDiffs,
        });
        oldLine += delLines.length;
        newLine += addLines.length;

        ++i; // 다음 added 블록
      } else {
        ops.push({ type: "del", oldStart: oldLine, lines: delLines });
        oldLine += delLines.length;
      }
      continue;
    }

    if (c.added && !c.removed) {
      const addLines = splitLines(c.value);
      ops.push({ type: "add", newStart: newLine, lines: addLines });
      newLine += addLines.length;
      continue;
    }
  }

  return ops;
}

// 라인 diff 요약
function summarizeGitOps(ops) {
  let added = 0,
    deleted = 0,
    modified = 0;
  for (const op of ops || []) {
    if (op.type === "add") {
      added += op.lines.length;
    } else if (op.type === "del") {
      deleted += op.lines.length;
    } else if (op.type === "modify") {
      modified += Math.max(op.oldLines.length, op.newLines.length);
    }
  }
  return { added, deleted, modified };
}

// (4) 유니파이드 패치 문자열 생성(다운로드/표시용)
function createUnifiedPatch(
  oldText,
  newText,
  oldLabel = "old",
  newLabel = "new",
  context = 3
) {
  return createTwoFilesPatch(
    oldLabel,
    newLabel,
    oldText,
    newText,
    undefined,
    undefined,
    { context }
  );
}

// (5) 문서를 직접 넣어 라인 diff+패치까지 한번에
function gitLikeDiffFromDocs(
  oldDoc,
  newDoc,
  { withIntraLine = true, oldLabel, newLabel, context = 3 } = {}
) {
  const oldText = docToText(oldDoc);
  const newText = docToText(newDoc);
  const ops = gitLikeDiff(oldText, newText, { withIntraLine });
  const summary = summarizeGitOps(ops);
  const unified_patch = createUnifiedPatch(
    oldText,
    newText,
    oldLabel,
    newLabel,
    context
  );
  return { ops, summary, unified_patch, oldText, newText };
}

// Equal 구간을 context 기준으로 위 아래 자르기
function clipGitOpsByContext(ops, context) {
  if (!Array.isArray(ops)) {
    return ops;
  }
  const ctx = Number.isFinite(context) ? context : 3;
  if (ctx === Infinity) {
    return ops;
  }

  // 세그먼트로 단순화: equal 런과 change를 번갈아 나열
  const segments = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "equal") {
      // equal 연속 구간 모으기
      let j = i;
      const lines = [];
      while (j < ops.length && ops[j].type === "equal") {
        if (Array.isArray(ops[j].lines)) lines.push(...ops[j].lines);
        j++;
      }
      segments.push({ kind: "equal", lines });
      i = j;
    } else {
      segments.push({ kind: "change", op });
      i++;
    }
  }

  const firstChangeIdx = segments.findIndex((s) => s.kind === "change");
  const lastChangeIdx = (() => {
    for (let k = segments.length - 1; k >= 0; k--) {
      if (segments[k].kind === "change") return k;
    }
    return -1;
  })();

  // 변경이 하나도 없으면: head ctx + … + tail ctx
  if (firstChangeIdx === -1) {
    const lines = segments.reduce((acc, s) => {
      if (s.kind === "equal") acc.push(...s.lines);
      return acc;
    }, []);
    if (lines.length <= ctx * 2)
      return lines.length ? [{ type: "equal", lines }] : [];
    const head = lines.slice(0, ctx);
    const tail = lines.slice(lines.length - ctx);
    const out = [];
    if (head.length) {
      out.push({ type: "equal", lines: head });
    }
    out.push({ type: "equal", lines: ["…"] });
    if (tail.length) {
      out.push({ type: "equal", lines: tail });
    }
    return out;
  }

  // 변경이 있는 경우: head / middle / tail 컨텍스트만 유지
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "change") {
      out.push(seg.op);
      continue;
    }

    const lines = seg.lines || [];
    if (i < firstChangeIdx) {
      // head: 마지막 ctx 줄만
      const keep = Math.min(ctx, lines.length);
      if (lines.length > keep) {
        out.push({ type: "equal", lines: ["…"] });
      }
      if (keep > 0) {
        out.push({ type: "equal", lines: lines.slice(lines.length - keep) });
      }
    } else if (i > lastChangeIdx) {
      // tail: 처음 ctx 줄만
      const keep = Math.min(ctx, lines.length);
      if (keep > 0) {
        out.push({ type: "equal", lines: lines.slice(0, keep) });
      }
      if (lines.length > keep) {
        out.push({ type: "equal", lines: ["…"] });
      }
    } else {
      // middle: 앞 ctx + … + 뒤 ctx
      if (lines.length <= ctx * 2) {
        if (lines.length) {
          out.push({ type: "equal", lines });
        }
      } else {
        const head = lines.slice(0, ctx);
        const tail = lines.slice(lines.length - ctx);
        if (head.length) {
          out.push({ type: "equal", lines: head });
        }
        out.push({ type: "equal", lines: ["…"] });
        if (tail.length) {
          out.push({ type: "equal", lines: tail });
        }
      }
    }
  }

  return out;
}

module.exports = {
  compare,
  applyPatch,
  summarizeDiffs,
  countChars,
  extractTextFromPM,
  countCharDelta,

  // Git-like 라인 diff 관련
  docToText,
  gitLikeDiff,
  summarizeGitOps,
  createUnifiedPatch,
  gitLikeDiffFromDocs,
  clipGitOpsByContext,
};
