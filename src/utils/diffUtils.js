const { compare, applyPatch } = require("fast-json-patch");
const { get: getByPointer } = require("jsonpointer");
const { diffChars } = require("diff");
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

module.exports = { compare, applyPatch, summarizeDiffs, countChars };
