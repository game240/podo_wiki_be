const supabase = require("../config/supabaseClient");
const {
  applyPatch,
  extractTextFromPM,
  countCharDelta,
} = require("../utils/diffUtils");
const { reconstructRevisionContent } = require("../services/revisionServices");

// 최근 리비전 목록과 diff 요약 반환
exports.listChanges = async (req, res) => {
  try {
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // 1) 총 개수
    const { count: totalCount, error: countErr } = await supabase
      .from("revisions")
      .select("id", { head: true, count: "exact" });
    if (countErr) throw countErr;

    // 2) 최근 리비전 목록
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
      .order("id", { ascending: false }) // 동순위 깨짐 방지
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // 3) per-revision +/– 문자수 계산
    //    최적화: 같은 page_id를 묶어서 캐시, 또는 최신→이전 순서로 누적/역패치
    const prevCache = new Map(); // key: `${page_id}:${rev_number}` → doc

    const changes = await Promise.all(
      revs.map(async (r) => {
        // (a) 이전 문서 복원
        let previousDoc;
        if (r.rev_number > 1) {
          const key = `${r.page_id}:${r.rev_number - 1}`;
          if (prevCache.has(key)) {
            previousDoc = prevCache.get(key);
          } else {
            previousDoc = await reconstructRevisionContent(
              r.page_id,
              r.rev_number - 1
            );
            prevCache.set(key, previousDoc);
          }
        } else {
          previousDoc = {};
        }

        // (b) 현재 문서 = 이전문서 + patch
        const patch = Array.isArray(r.diff) ? r.diff : [];
        const safePrev = previousDoc
          ? JSON.parse(JSON.stringify(previousDoc))
          : {};
        const { newDocument: currentDoc } = applyPatch(safePrev, patch, true);

        // (c) 텍스트 추출 → 문자 diff
        const prevText = extractTextFromPM(previousDoc);
        const currText = extractTextFromPM(currentDoc);
        const { added, removed, replacements } = countCharDelta(prevText, currText);

        return {
          revision_id: r.id,
          page_id: r.page_id,
          title: r.pages?.title ?? null,
          modifier: r.profiles?.nickname ?? null,
          edited_at: r.created_at,
          rev_number: r.rev_number,
          addedCount: added, // +몇자
          removedCount: removed, // -몇자
          modifiedCount: replacements, // (선택) 교체로 추정된 문자수
        };
      })
    );

    const totalPages = Math.ceil((totalCount || 0) / limit);
    const hasMore = offset + (revs?.length || 0) < (totalCount || 0);

    res.json({
      changes,
      pagination: { totalCount, totalPages, hasMore, limit, offset },
    });
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
    res.status(500).json({
      message: "최근 페이지 목록 조회 중 오류 발생",
      error: err.message,
    });
  }
};
