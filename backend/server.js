const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { HfInference } = require("@huggingface/inference");
const multer = require("multer");
const { spawn } = require("child_process");

// Allow CORS from frontend
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://verifai-frontend.onrender.com', 'https://verifiai-3431b785f8d8.herokuapp.com', 'https://verfi-ai-frontend-git-main-frank-lis-projects-dd5cce8a.vercel.app', '*'] 
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:8080', '*'],
  credentials: true,
  optionsSuccessStatus: 200
};

// 🔹 Initialize Firebase
const serviceAccount = require("./firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

const db = admin.firestore();
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

// Logging helper function
const logDebug = (...args) => {
  console.debug("[DEBUG]", ...args);
};

logDebug("Server starting...");

// 🔹 Multer Configuration for File Uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = "uploads";
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir);
      logDebug("Created uploads directory:", uploadsDir);
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const filename = Date.now() + "-" + file.originalname;
    logDebug("Saving file as:", filename);
    cb(null, filename);
  },
});

const upload = multer({ storage });

// 🔹 API: Create a new user
app.post("/api/create-user", async (req, res) => {
  logDebug("Received create-user request:", req.body);
  const { email, password, firstName, lastName } = req.body;
  try {
    await admin.auth().getUserByEmail(email);
    logDebug("Email already in use:", email);
    return res.status(400).json({
      success: false,
      message: "Email already in use.",
    });
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      try {
        const userRecord = await admin.auth().createUser({ email, password });
        await db.collection("users").doc(userRecord.uid).set({
          firstName,
          lastName,
          email,
          createdAt: new Date(),
        });
        logDebug("Created new user:", userRecord.uid);
        return res.json({ success: true, uid: userRecord.uid });
      } catch (createError) {
        console.error("Error creating user:", createError);
        return res.status(400).json({
          success: false,
          message: createError.message,
        });
      }
    }
    console.error("Error checking email:", error);
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

// 🔹 API: Upload Document and Process Contents
app.post("/api/upload-document", upload.single("file"), async (req, res) => {
  logDebug("Upload-document endpoint called");
  if (!req.file) {
    logDebug("No file uploaded");
    return res.status(400).json({ error: "No file uploaded." });
  }
  logDebug("Uploaded file:", req.file.path);

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
    logDebug("Created uploads directory");
  }

  const pythonProcess = spawn("python3", [
    "./backend/scrapers/document_scraper.py",
    req.file.path,
  ]);

  let data = "";
  let errorData = "";

  pythonProcess.stdout.on("data", (chunk) => {
    data += chunk;
    logDebug("Python Output:", chunk.toString());
  });

  pythonProcess.stderr.on("data", (chunk) => {
    errorData += chunk;
    console.error("Python Error:", chunk.toString());
  });

  pythonProcess.on("close", async (code) => {
    logDebug("Document scraper process exited with code:", code);
    if (code !== 0) {
      return res.status(500).json({ error: "Failed to process document", details: errorData });
    }
    try {
      const result = JSON.parse(data);
      logDebug("Parsed result from document_scraper:", result);
      if (result.error) {
        return res.status(500).json({ error: result.error, details: result.details || "" });
      }
      const { text: extractedText, references, metadata, citation_style } = result;
      const docRef = await db.collection("documents").add({
        fileName: req.file.originalname,
        extractedText,
        references,
        metadata,
        citationStyle: citation_style,
        uploadedAt: new Date(),
      });
      logDebug("Document saved to Firestore with ID:", docRef.id);
      res.json({
        success: true,
        documentId: docRef.id,
        extractedText,
        references,
        metadata,
        citationStyle: citation_style,
      });
    } catch (e) {
      console.error("Error parsing document result:", e);
      res.status(500).json({ error: "Invalid JSON response", details: e.message });
    }
  });
});

// 🔹 API: Generate Citations
app.post("/api/generate-citation", async (req, res) => {
  logDebug("Generate-citation endpoint called with body:", req.body);
  try {
    const { paperTitle, authors, year } = req.body;
    const input = `generate citation for: ${paperTitle} by ${authors} published in ${year}`;
    logDebug("Citation generation input:", input);
    const response = await hf.textGeneration({
      model: "scieditor/citation-generation-t5",
      inputs: input,
      parameters: { max_length: 512, temperature: 0.7 },
    });
    logDebug("Citation generation response:", response);
    res.json({ citation: response.generated_text });
  } catch (error) {
    console.error("Citation generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Chat with AI about Paper Contents
app.post("/api/chat", async (req, res) => {
  logDebug("Chat endpoint called with body:", req.body);
  try {
    const { message, paperContent } = req.body;
    const input = `Context: ${paperContent}\nQuestion: ${message}`;
    logDebug("Chat input:", input);
    const response = await hf.textGeneration({
      model: "scieditor/citation-generation-t5",
      inputs: input,
      parameters: { max_length: 1024, temperature: 0.8 },
    });
    logDebug("Chat response:", response);
    res.json({ reply: response.generated_text });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Analyze Paper using DOI
app.post("/api/analyze-paper", async (req, res) => {
  logDebug("Analyze-paper endpoint called with body:", req.body);
  const { doi } = req.body;
  console.log("Received DOI:", doi);
  const pythonCommand = process.platform === "win32" ? "python" : "python3";
  logDebug("Using python command for DOI analysis:", pythonCommand);
  const pythonProcess = spawn(pythonCommand, ["./backend/scrapers/doi_citation.py", doi]);
  let data = "";
  let errorData = "";
  pythonProcess.stdout.on("data", (chunk) => {
    data += chunk;
    logDebug("DOI analysis Python stdout:", chunk.toString());
  });
  pythonProcess.stderr.on("data", (chunk) => {
    errorData += chunk;
    console.error("DOI analysis Python stderr:", chunk.toString());
  });
  pythonProcess.on("close", async (code) => {
    logDebug("DOI analysis process exited with code:", code);
    if (code !== 0) {
      return res.status(500).json({ error: "Failed to analyze paper", details: errorData });
    }
    try {
      const result = JSON.parse(data);
      logDebug("Parsed result from doi_citation.py:", result);
      res.json(result);
    } catch (e) {
      console.error("Error parsing JSON from DOI analysis:", e);
      res.status(500).json({ error: "Invalid JSON response", details: e.message });
    }
  });
});

// 🔹 API: Get ISBN Citation
app.post("/api/isbn-citation", async (req, res) => {
  logDebug("ISBN-citation endpoint called with body:", req.body);
  const { isbn } = req.body;
  try {
    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    logDebug("Using python command for ISBN analysis:", pythonCommand);
    const pythonProcess = spawn(pythonCommand, ["./backend/scrapers/isbn_citation.py", isbn]);
    let data = "";
    let errorData = "";
    pythonProcess.stdout.on("data", (chunk) => {
      data += chunk;
      logDebug("ISBN analysis Python stdout:", chunk.toString());
    });
    pythonProcess.stderr.on("data", (chunk) => {
      errorData += chunk;
      console.error("ISBN analysis Python stderr:", chunk.toString());
    });
    pythonProcess.on("close", (code) => {
      logDebug("ISBN analysis process exited with code:", code);
      if (code !== 0) {
        return res.status(500).json({ error: "Failed to process ISBN", details: errorData });
      }
      try {
        const results = JSON.parse(data);
        logDebug("Parsed ISBN result:", results);
        res.json(results);
      } catch (e) {
        console.error("Error parsing JSON from ISBN analysis:", e);
        res.status(500).json({ error: "Invalid JSON response", details: e.message });
      }
    });
  } catch (error) {
    console.error("ISBN processing error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Retrieve Uploaded Documents
app.get("/api/documents", async (req, res) => {
  logDebug("Retrieve documents endpoint called.");
  try {
    const snapshot = await db.collection("documents").orderBy("uploadedAt", "desc").get();
    const documents = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    logDebug("Retrieved documents:", documents);
    res.json(documents);
  } catch (error) {
    console.error("Error retrieving documents:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Get User
app.get("/api/users/:uid", async (req, res) => {
  logDebug("Get user endpoint called for uid:", req.params.uid);
  try {
    const userDoc = await db.collection("users").doc(req.params.uid).get();
    if (!userDoc.exists) {
      logDebug("User not found for uid:", req.params.uid);
      return res.status(404).json({ error: "User not found" });
    }
    res.json(userDoc.data());
  } catch (error) {
    console.error("Error retrieving user:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Get Paper by DOI
app.get("/api/papers/:doi", async (req, res) => {
  logDebug("Get paper by DOI endpoint called for doi:", req.params.doi);
  try {
    const paperDoc = await db.collection("papers").doc(req.params.doi).get();
    if (!paperDoc.exists) {
      logDebug("Paper not found for doi:", req.params.doi);
      return res.status(404).json({ error: "Paper not found" });
    }
    res.json(paperDoc.data());
  } catch (error) {
    console.error("Error retrieving paper:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Update User
app.put("/api/users/:uid", async (req, res) => {
  logDebug("Update user endpoint called for uid:", req.params.uid, "with body:", req.body);
  try {
    const { firstName, lastName, email } = req.body;
    await db.collection("users").doc(req.params.uid).update({
      firstName,
      lastName,
      email,
      updatedAt: new Date()
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Update Paper
app.put("/api/papers/:doi", async (req, res) => {
  logDebug("Update paper endpoint called for doi:", req.params.doi, "with body:", req.body);
  try {
    const { title, authors, year } = req.body;
    await db.collection("papers").doc(req.params.doi).update({
      title,
      authors,
      year,
      updatedAt: new Date()
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating paper:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Delete User
app.delete("/api/users/:uid", async (req, res) => {
  logDebug("Delete user endpoint called for uid:", req.params.uid);
  try {
    await admin.auth().deleteUser(req.params.uid);
    await db.collection("users").doc(req.params.uid).delete();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Delete Paper
app.delete("/api/papers/:doi", async (req, res) => {
  logDebug("Delete paper endpoint called for doi:", req.params.doi);
  try {
    await db.collection("papers").doc(req.params.doi).delete();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting paper:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 API: Verify Reference
app.post("/api/verify-reference", async (req, res) => {
  logDebug("Verify reference endpoint called with reference:", req.body.reference);
  const { reference } = req.body;
  try {
    if (reference.doi) {
      logDebug("Reference has DOI:", reference.doi);
      const pythonCommand = process.platform === "win32" ? "python" : "python3";
      logDebug("Using python command:", pythonCommand);
      const pythonProcess = spawn(pythonCommand, ["./backend/scrapers/check_paper.py", reference.doi]);
      let data = "";
      let errorData = "";
      pythonProcess.stdout.on("data", (chunk) => {
        data += chunk;
        logDebug("Verify-reference python stdout:", chunk.toString());
      });
      pythonProcess.stderr.on("data", (chunk) => {
        errorData += chunk;
        console.error("Verify-reference python stderr:", chunk.toString());
      });
      pythonProcess.on("close", (code) => {
        logDebug("Verify-reference python process exited with code:", code);
        if (code !== 0) {
          return res.status(500).json({
            verification_status: "failed",
            error: "Failed to verify reference",
            details: errorData
          });
        }
        try {
          const results = JSON.parse(data);
          logDebug("Verify-reference parsed results:", results);
          const isVerified = results.arxiv.length > 0 ||
                             results.semantic_scholar.length > 0 ||
                             results.crossref.length > 0;
          const isRetracted = results.retracted.length > 0;
          res.json({
            verification_status: isVerified ? (isRetracted ? "retracted" : "verified") : "not_found",
            results
          });
        } catch (e) {
          res.status(500).json({
            verification_status: "failed",
            error: "Invalid JSON response",
            details: e.message
          });
        }
      });
    } else if (reference.title) {
      logDebug("Reference has title:", reference.title);
      const pythonCommand = process.platform === "win32" ? "python" : "python3";
      logDebug("Using python command:", pythonCommand);
      const pythonProcess = spawn(pythonCommand, ["./backend/scrapers/check_paper.py", reference.title]);
      let data = "";
      let errorData = "";
      pythonProcess.stdout.on("data", (chunk) => {
        data += chunk;
        logDebug("Verify-reference (title) python stdout:", chunk.toString());
      });
      pythonProcess.stderr.on("data", (chunk) => {
        errorData += chunk;
        console.error("Verify-reference (title) python stderr:", chunk.toString());
      });
      pythonProcess.on("close", (code) => {
        logDebug("Verify-reference (title) python process exited with code:", code);
        if (code !== 0) {
          return res.status(500).json({
            verification_status: "failed",
            error: "Failed to verify reference",
            details: errorData
          });
        }
        try {
          const results = JSON.parse(data);
          logDebug("Verify-reference (title) parsed results:", results);
          const isVerified = results.arxiv.length > 0 ||
                             results.semantic_scholar.length > 0 ||
                             results.crossref.length > 0;
          const isRetracted = results.retracted.length > 0;
          res.json({
            verification_status: isVerified ? (isRetracted ? "retracted" : "verified") : "not_found",
            results
          });
        } catch (e) {
          res.status(500).json({
            verification_status: "failed",
            error: "Invalid JSON response",
            details: e.message
          });
        }
      });
    } else {
      res.status(400).json({
        verification_status: "failed",
        error: "Reference must have either a DOI or title for verification"
      });
    }
  } catch (error) {
    console.error("Reference verification error:", error);
    res.status(500).json({
      verification_status: "failed",
      error: error.message
    });
  }
});

// 🔹 Start the Server
const port = process.env.PORT || 3002;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
