const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

const app = express();
app.use(bodyParser.json());

/* =============================
   🔹 Firebase Admin Setup via ENV
============================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL || "https://cme-access-management.firebaseio.com/"
});

/* =============================
   🔹 Signup Endpoint
============================= */
app.post("/signup", async (req, res) => {
  try {
    const { uid, name, email, role } = req.body;
    if (!uid || !name || !email || !role)
      return res.status(400).send({ success: false, message: "All fields required" });

    const path =
      role === "staff" ? `/staff/${uid}` :
      role === "rp" ? `/rp/${uid}` :
      `/users/${uid}`;

    // Save user in Firebase
    await admin.database().ref(path).update({ name, email, role, verified: false });

    // Queue email for admin approval
    const emailQueueRef = admin.database().ref("/emailQueue").push();
    await emailQueueRef.set({
      to: process.env.ADMIN_EMAIL, // use ENV variable
      subject: "New User Signup Approval",
      body: `
        <h2>New user signed up</h2>
        <p><b>Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Role:</b> ${role}</p>
        <p>Click to approve:</p>
        <a href="https://your-backend.com/approve?uid=${uid}&role=${role}" 
           style="padding:10px 16px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;">
           Approve User
        </a>
      `,
      status: "pending",
      retries: 0
    });

    res.send({ success: true, message: "User registered and email queued" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: err.message });
  }
});

/* =============================
   🔹 Admin Approval Endpoint
============================= */
app.get("/approve", async (req, res) => {
  const { uid, role } = req.query;
  if (!uid || !role) return res.status(400).send("<h3>Missing uid or role</h3>");

  const path =
    role === "staff" ? `/staff/${uid}` :
    role === "rp" ? `/rp/${uid}` :
    `/users/${uid}`;

  try {
    await admin.database().ref(path).update({ verified: true });

    // Fetch user data for push notification if needed
    const snapshot = await admin.database().ref(path).once("value");
    const user = snapshot.val();

    // Optional: send push notification if user.playerId exists
    if (user && user.playerId) {
      console.log("Send push notification logic here");
    }

    res.send("<h2>✅ User verified successfully!</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("<h2>❌ Error verifying user</h2>");
  }
});

/* =============================
   🔹 Start Server
============================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
