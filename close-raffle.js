
const { getVercelOidcToken } = require("@vercel/oidc");
const { GoogleAuth } = require("google-auth-library");

const PROJECT_ID = "zeka-sorteo";
const RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const idToken = await getVercelOidcToken();

    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/datastore"],
      credentials: {
        type: "external_account",
        audience: process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: {
          environment_id: "aws1",
          region_url: "http://169.254.169.254/latest/meta-data/placement/availability-zone",
          url: "http://169.254.169.254/latest/meta-data/iam/security-credentials",
          regional_cred_verification_url: "http://169.254.169.254/latest/meta-data/iam/security-credentials"
        }
      }
    });

    return res.status(501).json({
      error: "Falta conectar la autenticación OIDC de Vercel."
    });

  } catch (error) {
    console.error("Error cerrando venta:", error);
    return res.status(500).json({ error: "No se pudo cerrar la venta." });
  }
};
