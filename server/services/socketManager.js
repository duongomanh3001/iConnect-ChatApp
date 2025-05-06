const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const Group = require("../Models/groupModel");
const chatController = require("../controllers/chatController");
const friendshipController = require("../controllers/friendshipController");

dotenv.config();

// Lưu trữ kết nối socket và trạng thái người dùng
const userSockets = new Map(); // userId -> socketId
const onlineUsers = new Set(); // danh sách userId đang online
let connectCounter = 0; // Đếm số lượng kết nối để giảm log

// Khởi tạo Socket.IO server
function initSocketServer(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Thêm cài đặt ping timeout và thời gian chờ
  io.engine.pingTimeout = 60000; // 60 giây
  io.engine.pingInterval = 25000; // 25 giây

  io.on("connection", (socket) => {
    // Chỉ log thông tin socket.id nếu cần thiết cho debug
    connectCounter++;
    if (connectCounter % 10 === 0) {
      console.log(
        `[Connection Stats] Total connections: ${connectCounter}, Active users: ${onlineUsers.size}`
      );
    }

    let currentUserId = null;
    let authenticated = false;

    // Lấy thông tin người dùng từ token
    const token = socket.handshake.auth.token;
    if (token) {
      try {
        // Giải mã token để lấy user._id
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded._id || decoded.id;

        if (userId) {
          authenticated = true;
          currentUserId = userId;
          console.log(`User ${userId} connected with socket ${socket.id}`);

          // Lưu socket id của người dùng
          userSockets.set(userId, socket.id);
          onlineUsers.add(userId);

          // Người dùng tham gia phòng riêng với ID của họ
          socket.join(userId);

          // Thông báo cho các người dùng khác biết người dùng này đã online
          socket.broadcast.emit("userOnline", userId);

          // Gửi danh sách người dùng đang online cho người vừa kết nối
          socket.emit("onlineUsers", Array.from(onlineUsers));

          // Tự động tham gia vào tất cả các phòng nhóm mà người dùng là thành viên
          joinUserGroups(userId, socket);
        }
      } catch (error) {
        console.error("Error authenticating socket connection:", error);
      }
    }

    // Hàm để tự động tham gia vào tất cả các nhóm của người dùng
    async function joinUserGroups(userId, socket) {
      try {
        // Tìm tất cả các nhóm mà người dùng là thành viên
        const groups = await Group.find({ members: userId });

        for (const group of groups) {
          const groupRoomId = `group:${group._id}`;
          socket.join(groupRoomId);
          console.log(`User ${userId} joined group room: ${groupRoomId}`);
        }
      } catch (error) {
        console.error(`Error joining user groups: ${error.message}`);
      }
    }

    // Handle room joining (for private chats and compatibility with mobile)
    socket.on("joinRoom", (roomId) => {
      socket.join(roomId);
      console.log(`User ${currentUserId} joined room ${roomId}`);
    });

    // Tham gia vào phòng nhóm
    socket.on("joinGroupRoom", (groupId) => {
      const groupRoomId = `group:${groupId}`;
      socket.join(groupRoomId);
      console.log(`User ${currentUserId} joined group room: ${groupRoomId}`);
    });

    // Event đang nhập tin nhắn
    socket.on("typing", (data) => {
      const { sender, receiver } = data;

      // Gửi thông báo đến người nhận nếu họ đang online
      if (userSockets.has(receiver)) {
        io.to(receiver).emit("userTyping", { userId: sender });
      }
    });

    socket.on("stopTyping", (data) => {
      const { sender, receiver } = data;

      // Gửi thông báo đến người nhận nếu họ đang online
      if (userSockets.has(receiver)) {
        io.to(receiver).emit("userStoppedTyping", { userId: sender });
      }
    });

    // Event đang nhập trong nhóm
    socket.on("typingInGroup", (data) => {
      const { senderId, groupId, senderName } = data;
      const groupRoomId = `group:${groupId}`;

      // Gửi thông báo đến tất cả thành viên trong nhóm (trừ người gửi)
      socket.to(groupRoomId).emit("userTypingInGroup", {
        userId: senderId,
        groupId,
        userName: senderName,
      });
    });

    socket.on("stopTypingInGroup", (data) => {
      const { senderId, groupId } = data;
      const groupRoomId = `group:${groupId}`;

      // Gửi thông báo đến tất cả thành viên trong nhóm (trừ người gửi)
      socket.to(groupRoomId).emit("userStoppedTypingInGroup", {
        userId: senderId,
        groupId,
      });
    });

    // Xử lý sự kiện gửi tin nhắn
    socket.on("sendMessage", async (data) => {
      const {
        sender,
        receiver,
        content,
        type = "text",
        tempId,
        roomId,
        replyToId,
        fileUrl,
        fileName,
        fileSize,
        fileThumbnail,
        fileId,
        expiryDate,
      } = data;

      try {
        // Kiểm tra người gửi có đúng là người đang kết nối không
        if (sender !== currentUserId) {
          console.warn(`User ${currentUserId} trying to send message as ${sender}`);
          return;
        }

        // Tạo roomId từ userIds nếu không được cung cấp
        let effectiveRoomId = roomId;
        if (!effectiveRoomId) {
          const userIds = [sender, receiver].sort();
          effectiveRoomId = `${userIds[0]}_${userIds[1]}`;
        }

        // Tìm tin nhắn để trả lời nếu có
        let replyToData = null;
        if (replyToId) {
          const replyMessage = await chatController.findMessageById(replyToId);
          if (replyMessage) {
            replyToData = {
              _id: replyMessage._id,
              content: replyMessage.content,
              sender: replyMessage.sender,
            };
          }
        }

        // Lưu tin nhắn vào database
        const message = await chatController.saveMessage({
          roomId: effectiveRoomId,
          senderId: sender,
          receiver,
          content,
          type,
          tempId,
          replyTo: replyToData,
          fileUrl,
          fileName,
          fileSize,
          fileThumbnail,
          fileId,
          expiryDate,
        });

        // Xác định trạng thái tin nhắn dựa trên việc người nhận có online không
        const isReceiverOnline = userSockets.has(receiver);
        const initialStatus = isReceiverOnline ? "delivered" : "sent";

        // Chuẩn bị dữ liệu tin nhắn để gửi qua socket
        const messageWithTempId = {
          ...message.toObject(),
          status: initialStatus,
          _tempId: tempId,
        };

        // Gửi tin nhắn đến người gửi với tempId để cập nhật tin nhắn tạm thời trên UI
        io.to(sender).emit("receiveMessage", messageWithTempId);

        // Gửi tin nhắn đến người nhận nếu họ online
        if (isReceiverOnline) {
          io.to(receiver).emit("receiveMessage", {
            ...message.toObject(),
            status: "delivered",
          });
        }

        console.log(
          `Message sent from ${sender} to ${receiver} with status ${initialStatus}`
        );
      } catch (error) {
        console.error("Error sending message:", error);
        // Thông báo lỗi cho người gửi
        io.to(sender).emit("messageError", { tempId, error: error.message });
      }
    });

    // Xử lý phản ứng với tin nhắn
    socket.on("addReaction", async (data) => {
      const { messageId, userId, emoji } = data;

      // Kiểm tra người dùng
      if (userId !== currentUserId) {
        console.warn(`User ${currentUserId} trying to add reaction as ${userId}`);
        return;
      }

      try {
        // Lưu reaction vào cơ sở dữ liệu
        await chatController.addReaction(messageId, userId, emoji);

        // Lấy thông tin tin nhắn để biết người nhận
        const message = await chatController.findMessageById(messageId);

        if (message) {
          // Xác định người nhận thông báo (người gửi và người nhận tin nhắn gốc)
          const senderId = message.sender.toString();
          const receiverId = message.receiver.toString();

          console.log(`Gửi reaction từ ${userId} cho tin nhắn ${messageId}: ${emoji}`);

          // Chỉ gửi thông báo đến hai người trong cuộc trò chuyện
          if (userSockets.has(senderId)) {
            io.to(senderId).emit("messageReaction", { messageId, userId, emoji });
          }

          if (userSockets.has(receiverId)) {
            io.to(receiverId).emit("messageReaction", {
              messageId,
              userId,
              emoji,
            });
          }
        }
      } catch (error) {
        console.error("Error adding reaction:", error);
      }
    });

    // Sự kiện khi tin nhắn được xem
    socket.on("messageRead", (data) => {
      const { messageId, sender, receiver } = data;

      // Kiểm tra người nhận chính là người đang kết nối
      if (receiver !== currentUserId) {
        console.warn(`User ${currentUserId} trying to mark message as read for ${receiver}`);
        return;
      }

      // Thông báo cho người gửi ban đầu
      if (userSockets.has(sender)) {
        io.to(sender).emit("messageStatusUpdate", {
          messageId,
          status: "seen",
        });
      }
    });

    // Xử lý sự kiện thu hồi tin nhắn
    socket.on("unsendMessage", (data) => {
      const { messageId, senderId, receiverId } = data;

      // Kiểm tra người gửi
      if (senderId !== currentUserId) {
        console.warn(`User ${currentUserId} trying to unsend message as ${senderId}`);
        return;
      }

      // Thông báo cho người nhận tin nhắn rằng tin nhắn đã bị thu hồi
      if (userSockets.has(receiverId)) {
        io.to(receiverId).emit("messageUnsent", { messageId });
        console.log(
          `Đã thông báo thu hồi tin nhắn ${messageId} tới người dùng ${receiverId}`
        );
      }
    });

    // Xử lý sự kiện xóa toàn bộ cuộc trò chuyện
    socket.on("deleteConversation", (data) => {
      const { senderId, receiverId } = data;

      // Kiểm tra người gửi
      if (senderId !== currentUserId) {
        console.warn(`User ${currentUserId} trying to delete conversation as ${senderId}`);
        return;
      }

      // Thông báo cho người nhận rằng cuộc trò chuyện đã bị xóa
      if (userSockets.has(receiverId)) {
        io.to(receiverId).emit("conversationDeleted", { senderId });
        console.log(
          `Đã thông báo xóa cuộc trò chuyện từ ${senderId} tới người dùng ${receiverId}`
        );
      }
    });

    // Xử lý khi người dùng ngắt kết nối
    socket.on("disconnect", () => {
      // Chỉ log disconnect khi người dùng đã xác thực
      if (authenticated && currentUserId) {
        console.log(`User ${currentUserId} disconnected`);
        
        // Xóa thông tin socket và cập nhật trạng thái người dùng
        userSockets.delete(currentUserId);
        onlineUsers.delete(currentUserId);

        // Thông báo cho tất cả người dùng khác
        socket.broadcast.emit("userOffline", currentUserId);
      }
    });
  });

  return io;
}

module.exports = {
  initSocketServer,
  userSockets,
  onlineUsers
}; 