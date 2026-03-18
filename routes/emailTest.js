const express = require("express");
const router = express.Router();
const axios = require("axios");

router.post("/test", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.json({ success: false, error: "Email is required." });
    }

    // SUPER ADMIN ONLY CHECK - adjust based on your auth
    if (!req.user || req.user.role !== "superadmin") {
      return res.status(403).json({ success: false, error: "Access denied." });
    }

    const brevoKey = process.env.BREVO_API_KEY;

    if (!brevoKey) {
      return res.json({ success: false, error: "Brevo API key not configured." });
    }

    const htmlTemplate = `
      <html>
        <body style="background:#0d0d0d; color:#fff; padding:40px; font-family:Arial;">
          <h2 style="color:#3b82f6;">AiRingDesk Test Email</h2>
          <p>This is a test email to confirm your email delivery system is working correctly.</p>
        </body>
      </html>
    `;

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: "AiRingDesk", email: "no-reply@airingdesk.com" },
        to: [{ email }],
        subject: "AiRingDesk Test Email",
        htmlContent: htmlTemplate,
      },
      {
        headers: {
          "api-key": brevoKey,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Email error:", err.response?.data || err.message);
    res.json({ success: false, error: "Failed to send email." });
  }
});

module.exports = router;
