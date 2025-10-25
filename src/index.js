require("dotenv").config();
const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./docs/openapi");

const uploadRoutes = require("./routes/upload");
const pageRoutes = require("./routes/page");
const searchRoutes = require("./routes/search");
const recentRoutes = require("./routes/recent");

const app = express();
app.use(cors());
app.use(express.json());

// Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use("/api", uploadRoutes);
app.use("/api", pageRoutes);
app.use("/api", searchRoutes);
app.use("/api", recentRoutes);

const PORT = 3003;
app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`));
