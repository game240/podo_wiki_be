const supabase = require("../config/supabaseClient");
const { gitLikeDiffFromDocs, clipGitOpsByContext } = require("../utils/diffUtils");
const { reconstructRevisionContent } = require("../services/revisionServices");

// GET /api/diff?title=...&left_rev=current|number&right_rev=current|number&context=3
exports.getDiff = async (req, res) => {
  try {
    const { title, left_rev, right_rev, context } = req.query;
    if (!title) {
      return res
        .status(400)
        .json({ error: "title 쿼리 파라미터가 필요합니다." });
    }

    const { data: page, error: pageErr } = await supabase
      .from("pages")
      .select("id, title, current_rev")
      .eq("title", title)
      .maybeSingle();
    if (pageErr) throw pageErr;
    if (!page) {
      return res
        .status(404)
        .json({ error: "해당 제목의 페이지를 찾을 수 없습니다." });
    }

    const resolveRevNumber = async (revLike) => {
      if (
        revLike === undefined ||
        revLike === null ||
        revLike === "" ||
        String(revLike).toLowerCase() === "current"
      ) {
        if (!page.current_rev) {
          return res
            .status(404)
            .json({ error: "현재 리비전이 존재하지 않습니다." });
        }
        const { data: curr, error: currErr } = await supabase
          .from("revisions")
          .select("rev_number")
          .eq("id", page.current_rev)
          .single();
        if (currErr) throw currErr;
        return curr.rev_number;
      }
      const raw = String(revLike).trim();
      const n = parseInt(raw.replace(/^v/i, ""), 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("rev는 1 이상의 정수 또는 'current'여야 합니다.");
      }
      return n;
    };

    const leftNum = await resolveRevNumber(left_rev);
    const rightNum = await resolveRevNumber(right_rev);

    const [leftDoc, rightDoc] = await Promise.all([
      reconstructRevisionContent(page.id, leftNum),
      reconstructRevisionContent(page.id, rightNum),
    ]);

    const { ops, summary } = gitLikeDiffFromDocs(leftDoc, rightDoc, {
      withIntraLine: false,
      context: Number.isFinite(parseInt(context, 10))
        ? parseInt(context, 10)
        : 3,
    });
    const ctx = Number.isFinite(parseInt(context, 10))
      ? parseInt(context, 10)
      : 3;
    const trimmedOps = clipGitOpsByContext(ops, ctx);

    return res.json({
      title: page.title,
      page_id: page.id,
      left_rev: left_rev ?? "current",
      left_rev_number: leftNum,
      right_rev: right_rev ?? "current",
      right_rev_number: rightNum,
      ops: trimmedOps,
      summary,
    });
  } catch (err) {
    console.error("GET /api/diff Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
