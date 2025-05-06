const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const { authMiddleware } = require("../Middlewares/authMiddleware");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Tạo thư mục lưu trữ file nếu chưa tồn tại
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Cấu hình multer để lưu trữ file tạm thời trong bộ nhớ
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // Giới hạn kích thước file 50MB
});

// Tạo filter để kiểm tra loại file
const fileFilter = (req, file, cb) => {
  // Chấp nhận các loại file hình ảnh, video, audio và một số loại file phổ biến
  const fileTypes = {
    image: /^image\/(jpeg|jpg|png|gif|webp)$/,
    video: /^video\/.*$/, // Chấp nhận tất cả các loại video
    audio: /^audio\/.*$/, // Chấp nhận tất cả các loại audio
    document:
      /^application\/(pdf|msword|vnd.openxmlformats-officedocument.wordprocessingml.document|vnd.ms-excel|vnd.openxmlformats-officedocument.spreadsheetml.sheet|vnd.ms-powerpoint|vnd.openxmlformats-officedocument.presentationml.presentation|zip|x-rar-compressed|x-7z-compressed)$/,
  };

  const mime = file.mimetype;
  let accepted = false;

  // Kiểm tra file có hợp lệ không
  Object.values(fileTypes).forEach((regex) => {
    if (regex.test(mime)) {
      accepted = true;
    }
  });

  if (accepted) {
    cb(null, true);
  } else {
    cb(new Error("Loại file không được hỗ trợ"), false);
  }
};

// Giới hạn kích thước file là 50MB
const uploadMulter = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// Route cụ thể, đặt trước các route tổng quát
// Route để lấy danh sách cuộc trò chuyện gần đây
router.get("/recent", authMiddleware, chatController.getRecentChats);

// Route để upload file
router.post("/upload", upload.single("file"), chatController.uploadFile);

// Route to upload image directly to Cloudinary
router.post("/upload-image", authMiddleware, chatController.uploadToCloudinary);

// Development route for testing Cloudinary uploads (no auth required)
router.post(
  "/test-cloudinary-upload",
  chatController.uploadToCloudinary
);

// Route để truy cập media
router.get("/media/:fileId", chatController.getMedia);
router.delete("/media/:fileId", authMiddleware, chatController.deleteMedia);

// Route để lấy tin nhắn giữa 2 người dùng - đặt trước route chung
router.get("/messages/:userId1/:userId2", authMiddleware, chatController.getMessagesBetweenUsers);

// Route để lấy tin nhắn trong một phòng
router.get("/:roomId/messages", authMiddleware, chatController.getMessages);

// Route để lưu tin nhắn
router.post("/messages", authMiddleware, chatController.saveMessageRoute);

// Route để thu hồi tin nhắn
router.put("/messages/:messageId/unsend", authMiddleware, chatController.unsendMessage);

// Route để xóa cuộc trò chuyện
router.delete("/conversation/:userId1/:userId2", authMiddleware, chatController.deleteConversation);

// Route xử lý phản ứng tin nhắn
router.post("/messages/:messageId/reaction", authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user._id;

    await chatController.addReaction(messageId, userId, emoji);

    res.status(200).json({ message: "Reaction added successfully" });
  } catch (error) {
    console.error("Error adding reaction:", error);
    res.status(500).json({ message: "Error adding reaction", error: error.message });
  }
});
router.delete("/messages/:messageId/reaction", authMiddleware, chatController.removeReaction);

// Endpoint kiểm tra trạng thái cuộc trò chuyện
router.get("/status/:userId", authMiddleware, (req, res) => {
  res.json({ status: "online" });
});

// Xử lý lỗi upload
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        message: "File quá lớn. Kích thước tối đa là 50MB.",
      });
    }
    return res.status(400).json({ message: err.message });
  }
  next(err);
});

module.exports = router;
