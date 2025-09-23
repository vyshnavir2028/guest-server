const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

/* =============================
   🔹 Firebase Setup via ENV
============================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert({
    ...serviceAccount,
    private_key: serviceAccount.private_key.replace(/\\n/g, '\n') // ✅ fix newline issue
  }),
  databaseURL: process.env.FIREBASE_DB_URL || "https://cme-access-management.firebaseio.com/"
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
  else console.log("✅ Email transporter ready");
});

/* =============================
   🔹 Worker Function
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

        console.log("📧 Email sent to", emailItem.to);
        await admin.database().ref(`/emailQueue/${key}`).update({ status: "sent" });

      } catch (err) {
        console.error("⚠️ Email failed, will retry", err);
        const retries = (emailItem.retries || 0) + 1;
        await admin.database().ref(`/emailQueue/${key}`).update({ retries });
      }
    }
  } catch (err) {
    console.error("Worker error:", err);
  }
}

/* =============================
   🔹 Run Worker Every 15 Seconds
============================= */
setInterval(processEmailQueue, 15000);
console.log("🚀 Email worker running...");
