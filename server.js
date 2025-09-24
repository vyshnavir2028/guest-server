const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const OneSignal = require("onesignal-node");

const app = express();
app.use(bodyParser.json());

/* =============================
   🔹 Firebase Setup
============================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert({
    ...serviceAccount,
    private_key: serviceAccount.private_key.replace(/\\n/g, '\n')
  }),
  databaseURL: process.env.FIREBASE_DB_URL
});

/* =============================
   🔹 Gmail SMTP Setup
============================= */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

transporter.verify((error, success) => {
  if (error) console.error("Email transporter error:", error);
  else console.log("Email transporter ready");
});

/* =============================
   🔹 OneSignal Setup
============================= */
const oneSignalClient = new OneSignal.Client(
  process.env.ONESIGNAL_APP_ID,
  process.env.ONESIGNAL_API_KEY
);

/* =============================
   🔹 Signup Endpoint
============================= */
app.post("/signup", async (req, res) => {
  try {
    const { uid, name, email, role, playerId } = req.body;
    if (!uid || !name || !email || !role)
      return res.status(400).send({ success: false, message: "All fields required" });

    const path =
      role === "staff" ? `/staff/${uid}` :
      role === "rp" ? `/rp/${uid}` :
      `/users/${uid}`;

    // Only set playerId if it exists
    const dataToSave = { name, email, role, verified: false };
    if (playerId) dataToSave.playerId = playerId;

    await admin.database().ref(path).update(dataToSave);

    // Queue email for admin approval
    const emailQueueRef = admin.database().ref("/emailQueue").push();
    await emailQueueRef.set({
      to: process.env.ADMIN_EMAIL,
      subject: "New User Signup Approval",
      body: `
        <h2>New user signed up</h2>
        <p><b>Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Role:</b> ${role}</p>
        <p>Click to approve:</p>
        <a href="${process.env.BACKEND_URL}/approve?uid=${uid}&role=${role}" 
           style="padding:10px 16px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;">
           Approve User
        </a>
      `,
      status: "pending",
      retries: 0,
      type: "signup" // flag to identify admin email
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
    // Only set verified true, do NOT touch playerId or other fields
    await admin.database().ref(path).update({ verified: true });

    // Mark the admin email as sent in queue (if exists) to avoid duplicates
    const emailQueueSnapshot = await admin.database().ref("/emailQueue")
      .orderByChild("to").equalTo(process.env.ADMIN_EMAIL)
      .once("value");

    const emails = emailQueueSnapshot.val();
    if (emails) {
      for (const key in emails) {
        const item = emails[key];
        if (item.type === "signup" && item.status !== "sent") {
          await admin.database().ref(`/emailQueue/${key}`).update({ status: "sent" });
        }
      }
    }

    // Fetch user info
    const snapshot = await admin.database().ref(path).once("value");
    const user = snapshot.val();
    if (!user) return res.status(404).send("<h2>User not found</h2>");

    // Send push notification if playerId exists (only once)
    if (user.playerId && !user.notified) {
      const notification = {
        contents: { en: `Hi ${user.name}, your account has been approved! 🎉` },
        include_player_ids: [user.playerId],
      };
      try {
        await oneSignalClient.createNotification(notification);
        console.log("Push notification sent to:", user.name);
        // Mark as notified so it doesn’t repeat
        await admin.database().ref(path).update({ notified: true });
      } catch (pushErr) {
        console.error("Push notification error:", pushErr);
      }
    }

    // Send approval email to user only if not sent before
    if (user.email && !user.emailSent) {
      try {
        await transporter.sendMail({
          to: user.email,
          from: process.env.GMAIL_USER,
          subject: "Your Account Has Been Approved!",
          html: `
            <h2>Hi ${user.name},</h2>
            <p>Your account has been approved by the admin.</p>
            <p>You can now log in and start using the system.</p>
            <p>Thanks,<br/>Team</p>
          `
        });
        console.log(" Approval email sent to:", user.email);
        // Mark email sent
        await admin.database().ref(path).update({ emailSent: true });
      } catch (emailErr) {
        console.error("Email sending error:", emailErr);
      }
    }

    res.send("<h2>User verified successfully</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("<h2>Error verifying user</h2>");
  }
});

/* =============================
   🔹 Email Worker
============================= */
async function processEmailQueue() {
  try {
    const snapshot = await admin.database().ref("/emailQueue")
      .orderByChild("status").equalTo("pending")
      .once("value");

    const emails = snapshot.val();
    if (!emails) return;

    for (const key in emails) {
      const emailItem = emails[key];
      try {
        await transporter.sendMail({
          to: emailItem.to,
          from: process.env.GMAIL_USER,
          subject: emailItem.subject,
          html: emailItem.body
        });

        console.log(" Email sent to", emailItem.to);
        await admin.database().ref(`/emailQueue/${key}`).update({ status: "sent" });
      } catch (err) {
        console.error("Email failed, will retry", err);
        const retries = (emailItem.retries || 0) + 1;
        await admin.database().ref(`/emailQueue/${key}`).update({ retries });
      }
    }
  } catch (err) {
    console.error("Worker error:", err);
  }
}

setInterval(processEmailQueue, 15000);
console.log(" Email worker running...");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
