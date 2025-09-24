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
   🔹 Signup Endpoint (Queue Admin Email)
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

    // Save user data
    const dataToSave = { name, email, role, verified: false };
    if (playerId) dataToSave.playerId = playerId;
    await admin.database().ref(path).update(dataToSave);

    // Ensure /emailQueue exists
    const emailQueueRef = admin.database().ref("/emailQueue");
    const snapshot = await emailQueueRef.once("value");
    if (!snapshot.exists()) {
      await emailQueueRef.set({});
    }

    // Push admin approval email
    const newEmailRef = emailQueueRef.push();
    await newEmailRef.set({
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
      type: "signup"
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
    const userRef = admin.database().ref(path);
    const snapshot = await userRef.once("value");
    const user = snapshot.val();
    if (!user) return res.status(404).send("<h2>User not found</h2>");

    // Update verified
    await userRef.update({ verified: true });

    // Send push notification if playerId exists and not yet notified
    if (user.playerId && !user.notified) {
      try {
        await oneSignalClient.createNotification({
          contents: { en: `Hi ${user.name}, your account has been approved! 🎉` },
          include_player_ids: [user.playerId],
        });
        await userRef.update({ notified: true });
      } catch (pushErr) {
        console.error("Push notification failed:", pushErr);
      }
    }

    // Queue approval email to user (if not sent yet)
    if (!user.emailSent) {
      const emailQueueRef = admin.database().ref("/emailQueue");
      const newEmailRef = emailQueueRef.push();
      await newEmailRef.set({
        to: user.email,
        subject: "Your Account Has Been Approved!",
        body: `
          <h2>Hi ${user.name},</h2>
          <p>Your account has been approved by the admin.</p>
          <p>You can now log in and start using the system.</p>
          <p>Thanks,<br/>Team</p>
        `,
        status: "pending",
        retries: 0,
        type: "userApproval",
        uid
      });
      console.log("Approval email queued for user:", user.email);
    }

    res.send("<h2>User verified successfully</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("<h2>Error verifying user</h2>");
  }
});

/* =============================
   🔹 Email Worker (Guaranteed Delivery)
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

        console.log("Email sent to:", emailItem.to);
        await admin.database().ref(`/emailQueue/${key}`).update({ status: "sent" });

        // If this email is user approval, mark emailSent in user record
        if (emailItem.type === "userApproval" && emailItem.uid) {
          const userPath = `/staff/${emailItem.uid}`; // Adjust if needed for RP/users
          const userSnap = await admin.database().ref(userPath).once("value");
          if (userSnap.exists()) {
            await admin.database().ref(userPath).update({ emailSent: true });
          }
        }
      } catch (err) {
        console.error("Email send failed, retrying later:", err);
        const retries = (emailItem.retries || 0) + 1;
        await admin.database().ref(`/emailQueue/${key}`).update({ retries });
      }
    }
  } catch (err) {
    console.error("Email worker error:", err);
  }
}

setInterval(processEmailQueue, 10000);
console.log("Email worker running...");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
