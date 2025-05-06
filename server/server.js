const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const friendshipRoute = require("./Routes/friendshipRoute");
const searchRoute = require("./Routes/searchRoute");
const userRoute = require("./Routes/userRoute");
const chatRoute = require("./Routes/chatRoute");
const groupRoute = require("./Routes/groupRoute");
const socketManager = require("./services/socketManager");
require("dotenv").config();

// Tạo HTTP server từ Express app
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Đăng ký các routes API
app.use("/api/auth", userRoute);
app.use("/api/user", userRoute);
app.use("/api/friendship", friendshipRoute);
app.use("/api/friends", friendshipRoute);
app.use("/api/groups", groupRoute);
app.use("/api/chat", chatRoute);
app.use("/api/search", searchRoute);

// Kết nối đến MongoDB
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/italk")
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Khởi tạo socket.io server
const io = socketManager.initSocketServer(server);

// Health check API
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    serverTime: new Date().toLocaleTimeString(),
    environment: process.env.NODE_ENV || "development",
    connections: {
      online: socketManager.onlineUsers.size,
      sockets: socketManager.userSockets.size,
    },
  });
});

// Khởi động server
const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
