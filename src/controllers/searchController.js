const supabase = require("../config/supabaseClient");

exports.searchPages = async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "검색어(q)를 전달하세요." });

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);
  const from = (page - 1) * pageSize;

  const { data, error: rpcError } = await supabase.rpc("search_pages", {
    _q: q,
    _from: from,
    _limit: pageSize,
  });
  if (rpcError) {
    console.error("RPC 에러:", rpcError);
    return res.status(500).json({ error: rpcError.message });
  }

  const total = data.length > 0 ? Number(data[0].total_count) : 0;
  const totalPages = Math.ceil(total / pageSize);

  res.json({ data, pagination: { total, page, pageSize, totalPages } });
};

exports.autocomplete = async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.json([]);
  }

  try {
    const { data, error } = await supabase
      .from("pages")
      .select("title")
      .ilike("title", `${q}%`)
      .order("title", { ascending: true })
      .limit(10);

    if (error) throw error;

    // [{ title: '…' }, …] → ['…', …]
    const titles = data.map((r) => r.title);
    res.json(titles);
  } catch (err) {
    console.error("AUTOCOMPLETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};
