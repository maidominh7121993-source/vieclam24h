import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Simple In-memory Database with file persistence
  const DB_PATH = path.join(__dirname, "db.json");
  let db = {
    users: [],
    jobs: [],
    applications: [],
    chats: [],
    messages: [],
    transactions: [],
    notifications: []
  };

  if (fs.existsSync(DB_PATH)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    } catch (e) {
      console.error("Error loading DB", e);
    }
  }

  const saveDB = () => {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  };

  // --- API Routes ---

  // Auth
  app.post("/api/auth/login", (req, res) => {
    const { phone } = req.body;
    let user = db.users.find(u => u.phone === phone);
    if (!user) {
      user = { 
        userId: Date.now().toString(), 
        phone, 
        name: "Người dùng mới", 
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${phone}`,
        location: "Hồ Chí Minh",
        rating: 5.0,
        credits: 100000, // Initial free credits
        isVerified: false,
        identityScore: 0,
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      saveDB();
    }
    res.json(user);
  });

  app.get("/api/users/:id", (req, res) => {
    const user = db.users.find(u => u.userId === req.params.id);
    if (user) {
      res.json(user);
    } else {
      res.status(404).json({ error: "User not found" });
    }
  });

  app.post("/api/users/:id/recharge", (req, res) => {
    const { amount, method } = req.body;
    const index = db.users.findIndex(u => u.userId === req.params.id);
    if (index !== -1) {
      db.users[index].credits = (db.users[index].credits || 0) + amount;
      
      // Log transaction
      db.transactions.push({
        transactionId: Date.now().toString(),
        userId: req.params.id,
        amount,
        method,
        type: 'recharge',
        timestamp: new Date().toISOString()
      });

      saveDB();
      res.json(db.users[index]);
    } else {
      res.status(404).json({ error: "Không tìm thấy người dùng" });
    }
  });

  // Jobs
  app.get("/api/jobs", (req, res) => {
    res.json(db.jobs);
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = db.jobs.find(j => j.jobId === req.params.id);
    if (job) {
      const employer = db.users.find(u => u.userId === job.employerId);
      res.json({ ...job, employer });
    } else {
      res.status(404).json({ error: "Không tìm thấy công việc" });
    }
  });

  app.post("/api/jobs", async (req, res) => {
    const { title, description } = req.body;
    
    // AI Moderation Check
    try {
      const model = "gemini-3-flash-preview";
      const prompt = `Kiểm duyệt nội dung tin tuyển dụng sau đây. Nếu nội dung vi phạm pháp luật, lừa đảo, chứa từ ngữ thô tục hoặc không phù hợp, hãy trả về "REJECT". Nếu nội dung an toàn, hãy trả về "APPROVE".
      Tiêu đề: ${title}
      Mô tả: ${description}`;
      
      const aiResponse = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text: prompt }] }]
      });
      
      const decision = aiResponse.text?.trim().toUpperCase();
      if (decision === "REJECT") {
        return res.status(400).json({ error: "Nội dung tin đăng không phù hợp hoặc vi phạm tiêu chuẩn cộng đồng. Vui lòng kiểm tra lại." });
      }
    } catch (e) {
      console.error("AI Moderation failed, falling back to manual", e);
    }

    const URGENT_COST = 5000;
    const userIndex = db.users.findIndex(u => u.userId === req.body.employerId);
    
    if (req.body.isUrgent) {
      if (userIndex === -1 || db.users[userIndex].credits < URGENT_COST) {
        return res.status(400).json({ error: "Số dư không đủ để đăng tin Cần gấp (5.000đ)" });
      }
      db.users[userIndex].credits -= URGENT_COST;
    }

    const newJob = { 
      jobId: Date.now().toString(), 
      createdAt: new Date().toISOString(),
      isBoosted: false,
      status: 'open',
      aiModerated: true,
      ...req.body 
    };
    db.jobs.push(newJob);
    saveDB();
    res.status(201).json({ job: newJob, user: db.users[userIndex] });
  });

  app.post("/api/jobs/:id/close", (req, res) => {
    const index = db.jobs.findIndex(j => j.jobId === req.params.id);
    if (index !== -1) {
      db.jobs[index].status = 'closed';
      saveDB();
      res.json(db.jobs[index]);
    } else {
      res.status(404).json({ error: "Không tìm thấy công việc" });
    }
  });

  app.post("/api/jobs/:id/boost", (req, res) => {
    const { userId } = req.body;
    const userIndex = db.users.findIndex(u => u.userId === userId);
    const jobIndex = db.jobs.findIndex(j => j.jobId === req.params.id);
    
    const BOOST_COST = 10000;

    if (userIndex === -1 || jobIndex === -1) {
      return res.status(404).json({ error: "Không tìm thấy người dùng hoặc công việc" });
    }

    if (db.users[userIndex].credits < BOOST_COST) {
      return res.status(400).json({ error: "Không đủ số dư để đẩy tin" });
    }

    db.users[userIndex].credits -= BOOST_COST;
    db.jobs[jobIndex].isBoosted = true;
    saveDB();
    
    res.json({ job: db.jobs[jobIndex], user: db.users[userIndex] });
  });

  app.delete("/api/jobs/:id", (req, res) => {
    db.jobs = db.jobs.filter(j => j.jobId !== req.params.id);
    saveDB();
    res.json({ success: true });
  });

  // Applications
  app.post("/api/applications", (req, res) => {
    const newApp = {
      applicationId: Date.now().toString(),
      appliedAt: new Date().toISOString(),
      status: 'pending',
      ...req.body
    };
    db.applications.push(newApp);
    saveDB();
    res.status(201).json(newApp);
  });

  app.post("/api/applications/:id/status", (req, res) => {
    const { status } = req.body;
    const index = db.applications.findIndex(a => a.applicationId === req.params.id);
    if (index !== -1) {
      db.applications[index].status = status;
      saveDB();
      res.json(db.applications[index]);
    } else {
      res.status(404).json({ error: "Không tìm thấy hồ sơ ứng tuyển" });
    }
  });

  app.post("/api/users/:id/verify", (req, res) => {
    const index = db.users.findIndex(u => u.userId === req.params.id);
    if (index !== -1) {
      db.users[index].isVerified = true;
      db.users[index].identityScore = 100;
      saveDB();
      res.json(db.users[index]);
    } else {
      res.status(404).json({ error: "Không tìm thấy người dùng" });
    }
  });

  // Chats & Messages
  app.get("/api/chats/:userId", (req, res) => {
    const userChats = db.chats.filter(c => c.user1 === req.params.userId || c.user2 === req.params.userId);
    const enrichedChats = userChats.map(chat => {
      const otherUserId = chat.user1 === req.params.userId ? chat.user2 : chat.user1;
      const otherUser = db.users.find(u => u.userId === otherUserId);
      return { ...chat, otherUser };
    });
    res.json(enrichedChats);
  });

  app.post("/api/chats", (req, res) => {
    const { user1, user2 } = req.body;
    let chat = db.chats.find(c => (c.user1 === user1 && c.user2 === user2) || (c.user1 === user2 && c.user2 === user1));
    if (!chat) {
      chat = {
        chatId: Date.now().toString(),
        user1,
        user2,
        lastMessage: "",
        updatedAt: new Date().toISOString()
      };
      db.chats.push(chat);
      saveDB();
    }
    res.json(chat);
  });

  app.get("/api/messages/:chatId", (req, res) => {
    const messages = db.messages.filter(m => m.chatId === req.params.chatId);
    res.json(messages);
  });

  app.post("/api/messages", (req, res) => {
    const newMessage = {
      messageId: Date.now().toString(),
      timestamp: new Date().toISOString(),
      ...req.body
    };
    db.messages.push(newMessage);
    
    // Update last message in chat
    const chatIndex = db.chats.findIndex(c => c.chatId === req.body.chatId);
    if (chatIndex !== -1) {
      db.chats[chatIndex].lastMessage = req.body.text;
      db.chats[chatIndex].updatedAt = new Date().toISOString();
    }
    
    saveDB();
    res.status(201).json(newMessage);
  });

  // Admin Routes
  app.get("/api/admin/users", (req, res) => {
    // Simple check - in real app use auth middleware
    res.json(db.users);
  });

  app.post("/api/admin/users/:id/credits", (req, res) => {
    const { amount } = req.body;
    const index = db.users.findIndex(u => u.userId === req.params.id);
    if (index !== -1) {
      db.users[index].credits = amount;
      saveDB();
      res.json(db.users[index]);
    } else {
      res.status(404).json({ error: "User not found" });
    }
  });

  // Automated Payment Webhook (e.g., for Casso, SePay, or custom bank scrapers)
  app.post("/api/webhooks/payment", (req, res) => {
    // This endpoint handles incoming payment notifications
    // Expected payload structure (example): { amount: 50000, description: "VG1710360000000", transactionId: "..." }
    const { amount, description, transactionId } = req.body;

    if (!amount || !description) {
      return res.status(400).json({ error: "Missing amount or description" });
    }

    // Extract User ID from description (Pattern: VG + userId)
    const match = description.toUpperCase().match(/VG(\d+)/);
    if (!match) {
      console.log(`[Webhook] No user ID found in description: ${description}`);
      return res.status(200).json({ status: "ignored", reason: "No matching syntax" });
    }

    const userId = match[1];
    const userIndex = db.users.findIndex(u => u.userId === userId);

    if (userIndex === -1) {
      console.log(`[Webhook] User ${userId} not found`);
      return res.status(200).json({ status: "ignored", reason: "User not found" });
    }

    // Check if transaction already processed
    const alreadyProcessed = db.transactions.some(t => t.transactionId === transactionId);
    if (alreadyProcessed && transactionId) {
      return res.status(200).json({ status: "ignored", reason: "Duplicate transaction" });
    }

    // Update credits
    db.users[userIndex].credits = (db.users[userIndex].credits || 0) + amount;
    
    // Log transaction
    db.transactions.push({
      transactionId: transactionId || Date.now().toString(),
      userId: userId,
      amount,
      method: 'automated_bank_transfer',
      type: 'recharge',
      description,
      timestamp: new Date().toISOString()
    });

    saveDB();
    console.log(`[Webhook] Successfully recharged ${amount}đ for user ${userId}`);
    res.json({ status: "success", newBalance: db.users[userIndex].credits });
  });

  // Manual Recharge Notification
  app.post("/api/recharge/request", (req, res) => {
    const { userId, amount } = req.body;
    const user = db.users.find(u => u.userId === userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const notification = {
      id: Date.now().toString(),
      type: 'recharge_request',
      userId,
      userName: user.name,
      amount,
      status: 'pending',
      timestamp: new Date().toISOString()
    };

    db.notifications.push(notification);
    saveDB();
    res.json({ success: true });
  });

  app.get("/api/admin/notifications", (req, res) => {
    res.json(db.notifications.filter(n => n.status === 'pending'));
  });

  app.post("/api/admin/notifications/:id/approve", (req, res) => {
    const notifIndex = db.notifications.findIndex(n => n.id === req.params.id);
    if (notifIndex === -1) return res.status(404).json({ error: "Notification not found" });

    const notification = db.notifications[notifIndex];
    const userIndex = db.users.findIndex(u => u.userId === notification.userId);

    if (userIndex !== -1) {
      db.users[userIndex].credits = (db.users[userIndex].credits || 0) + notification.amount;
      
      db.transactions.push({
        transactionId: Date.now().toString(),
        userId: notification.userId,
        amount: notification.amount,
        method: 'manual_approval',
        type: 'recharge',
        timestamp: new Date().toISOString()
      });

      db.notifications[notifIndex].status = 'approved';
      saveDB();
      res.json({ success: true, newBalance: db.users[userIndex].credits });
    } else {
      res.status(404).json({ error: "User not found" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
