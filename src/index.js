require("dotenv").config();
const express = require("express");
const cors = require("cors");

const uploadRoutes = require("./routes/upload");
const pageRoutes = require("./routes/page");
const searchRoutes = require("./routes/search");
const recentRoutes = require("./routes/recent");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", uploadRoutes);
app.use("/api", pageRoutes);
app.use("/api", searchRoutes);
app.use("/api", recentRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`));
