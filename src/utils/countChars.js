function countChars(node) {
  let cnt = 0;
  if (Array.isArray(node)) {
    node.forEach((c) => (cnt += countChars(c)));
  } else if (node && typeof node === "object") {
    if (node.type === "text" && typeof node.text === "string") {
      cnt += node.text.length;
    }
    if (Array.isArray(node.content)) {
      cnt += countChars(node.content);
    }
  } else if (typeof node === "string") {
    cnt += node.length;
  }
  return cnt;
}

module.exports = countChars;
