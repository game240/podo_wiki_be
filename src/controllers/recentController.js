const supabase = require("../config/supabaseClient");
const { applyPatch } = require("fast-json-patch");
const { summarizeDiffs } = require("../utils/diffUtils");

// 스냅샷과 델타를 조합해 특정 리비전의 전체 문서를 복원
async function reconstructRevisionContent(page_id, target_rev_number) {
  const { data: snap, error: snapErr } = await supabase
    .from("revisions")
    .select("content, rev_number")
    .eq("page_id", page_id)
    .eq("is_snapshot", true)
    .lte("rev_number", target_rev_number)
    .order("rev_number", { ascending: false })
    .limit(1)
    .single();
  if (snapErr || !snap) return {};

  let doc = snap.content;
  const snapRev = snap.rev_number;

  const { data: deltas, error: deltaErr } = await supabase
    .from("revisions")
    .select("diff")
    .eq("page_id", page_id)
    .gt("rev_number", snapRev)
    .lte("rev_number", target_rev_number)
    .order("rev_number", { ascending: true });
  if (deltaErr) throw deltaErr;

  for (const { diff } of deltas) {
    const { newDocument } = applyPatch(doc, diff, true);
    doc = newDocument;
  }

  return doc;
}

// 최근 리비전 목록과 diff 요약 반환
exports.listChanges = async (req, res) => {
  try {
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { count: totalCount, error: countErr } = await supabase
      .from("revisions")
      .select("id", { head: true, count: "exact" });
    if (countErr) throw countErr;

    // 2-1) 최근 리비전 목록 조회
    const { data: revs, error } = await supabase
      .from("revisions")
      .select(
        `
          id, page_id, rev_number, diff, created_at,
          pages!revisions_page_id_fkey(title),
          profiles!revisions_created_by_profiles_fkey(nickname)
        `
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    // 2-2) 각 리비전에 대해 이전 전체 문서 복원 → diff 요약
    const changes = await Promise.all(
      revs.map(async (r) => {
        // 바로 이전 rev_number 의 전체 문서
        const previousDoc =
          r.rev_number > 1
            ? await reconstructRevisionContent(r.page_id, r.rev_number - 1)
            : {};

        const { added, removed, modified } = summarizeDiffs(
          r.diff || [],
          previousDoc
        );

        return {
          revision_id: r.id,
          page_id: r.page_id,
          title: r.pages.title,
          modifier: r.profiles.nickname,
          edited_at: r.created_at,
          rev_number: r.rev_number,
          diff: r.diff,
          addedCount: added,
          removedCount: removed,
          modifiedCount: modified,
        };
      })
    );

    const totalPages = Math.ceil((totalCount ?? 0) / limit);
    const hasMore = offset + revs.length < (totalCount ?? 0);

    res.json({ changes, pagination: { totalCount, totalPages, hasMore } });
  } catch (err) {
    console.error("GET /api/recent-change Error:", err);
    res.status(500).json({
      message: "최근 변경내역 조회 중 오류 발생",
      error: err.message,
    });
  }
};

// 최근 수정된 페이지 목록 반환
exports.listPages = async (req, res) => {
  try {
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { data: pages, error } = await supabase
      .from("pages")
      .select("id, title, updated_at", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    res.json({
      items: pages.map((p) => ({
        page_id: p.id,
        title: p.title,
        updated_at: p.updated_at,
      })),
    });
  } catch (err) {
    console.error("GET /api/recent-change/pages Error:", err);
    res
      .status(500)
      .json({
        message: "최근 페이지 목록 조회 중 오류 발생",
        error: err.message,
      });
  }
};
