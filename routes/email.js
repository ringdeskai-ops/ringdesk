const express = require("express");
const router = express.Router();
const SibApiV3Sdk = require("sib-api-v3-sdk");

const apiKey = process.env.BREVO_API_KEY;

router.post("/test", async (req, res) => {
  try {
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKeyAuth = defaultClient.authentications["api-key"];
    apiKeyAuth.apiKey = apiKey;

    const emailApi = new SibApiV3Sdk.TransactionalEmailsApi();

    const sendSmtpEmail = {
      sender: { email: "ringdeskai@gmail.com", name: "AiringDesk" },
      to: [{ email: req.body.email }],
      subject: "Test Email",
      htmlContent: "<p>This is a test email from your server.</p>",
    };

    await emailApi.sendTransacEmail(sendSmtpEmail);

    res.json({ success: true, message: "Email sent successfully!" });
  } catch (error) {
    console.error("Email error:", error);
    res.json({ success: false, error: "Failed to send email." });
  }
});

module.exports = router;
