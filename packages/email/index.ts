import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY!);

export const verifyEmailMail = (
  appName: string,
  firstName: string,
  userEmail: string,
  verifyUrl: string,
  companyAddress: string,
  helpUrl: string,
) => `
<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Verify your email</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<style>
  table {border-collapse:collapse;}
  td,th,div,p,a,h1,h2,h3 {font-family:Arial, sans-serif;}
</style>
<![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; background-color: #f4f4f5; }

  .bg-body   { background-color: #f4f4f5; }
  .bg-card   { background-color: #ffffff; }
  .text-main { color: #18181b; }
  .text-sub  { color: #71717a; }
  .divider   { border-top: 1px solid #e4e4e7; }
  .btn-bg    { background-color: #18181b; }
  .btn-text  { color: #ffffff !important; }
  .code-box  { background-color: #f4f4f5; color: #18181b; }

  @media (prefers-color-scheme: dark) {
    .bg-body   { background-color: #09090b !important; }
    .bg-card   { background-color: #18181b !important; }
    .text-main { color: #fafafa !important; }
    .text-sub  { color: #a1a1aa !important; }
    .divider   { border-top: 1px solid #27272a !important; }
    .code-box  { background-color: #27272a !important; color: #fafafa !important; }
    .btn-bg    { background-color: #fafafa !important; }
    .btn-text  { color: #18181b !important; }
  }

  @media (prefers-color-scheme: dark) {
    a.btn:hover { background-color: #e4e4e7 !important; }
  }

  @media screen and (max-width: 600px) {
    .email-container { width: 100% !important; }
    .fluid-padding { padding-left: 20px !important; padding-right: 20px !important; }
    .h1-mobile { font-size: 22px !important; line-height: 28px !important; }
  }

  a.btn:hover { background-color: #27272a !important; }
</style>
</head>
<body class="bg-body" style="margin:0; padding:0; background-color:#f4f4f5;">
  <!-- Preheader (hidden preview text) -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    Confirm your email address to finish setting up your account. This link expires in 30 minutes.
    &#847; &zwnj; &nbsp; &#8199; &#8203; &#847; &zwnj; &nbsp; &#8199; &#8203;
  </div>

  <center class="bg-body" style="width:100%; background-color:#f4f4f5;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="bg-body">
      <tr>
        <td align="center" style="padding: 32px 16px;">

          <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="email-container" style="width:600px; max-width:600px;">
            <!-- Logo -->
            <tr>
              <td align="center" style="padding-bottom: 24px;">
                <img src="https://your-cdn.example.com/logo.png" width="140" alt="YourApp" style="display:block; width:140px;">
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td class="bg-card" style="border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td class="fluid-padding" style="padding: 40px 48px 24px 48px;">
                      <h1 class="text-main h1-mobile" style="margin:0 0 16px 0; font-family:Arial,Helvetica,sans-serif; font-size:24px; line-height:30px; font-weight:700;">
                        Confirm your email
                      </h1>
                      <p class="text-sub" style="margin:0 0 24px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px;">
                        Hi ${firstName}, thanks for signing up. Click the button below to verify
                        <strong class="text-main">${userEmail}</strong> and activate your account.
                      </p>
                    </td>
                  </tr>

                  <!-- Bulletproof button -->
                  <tr>
                    <td class="fluid-padding" align="center" style="padding: 0 48px 24px 48px;">
                      <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${verifyUrl}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="12%" fillcolor="#18181b" stroke="f">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Verify email address</center>
                      </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-->
                      <a href="${verifyUrl}" class="btn btn-bg btn-text" target="_blank"
                         style="background-color:#18181b; color:#ffffff; display:inline-block; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:700; line-height:48px; text-align:center; text-decoration:none; width:220px; border-radius:8px; -webkit-text-size-adjust:none;">
                        Verify email address
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>

                  <tr>
                    <td class="fluid-padding" style="padding: 0 48px 32px 48px;">
                      <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        Or paste this link into your browser:<br>
                        <a href="${verifyUrl}" class="text-main" style="text-decoration:underline; word-break:break-all;">${verifyUrl}</a>
                      </p>
                    </td>
                  </tr>

                  <tr><td class="fluid-padding" style="padding: 0 48px;"><div class="divider"></div></td></tr>

                  <tr>
                    <td class="fluid-padding" style="padding: 24px 48px 40px 48px;">
                      <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        This link expires in 30 minutes. If you didn't create an account with ${appName}, you can safely ignore this email.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding: 24px 20px;">
                <p class="text-sub" style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  ${appName}, ${companyAddress}
                </p>
                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  <a href="${helpUrl}" style="color:#71717a; text-decoration:underline;">Need help?</a>
                </p>
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </center>
</body>
</html>

`;

export const resetPasswordMail = (
  appName: string,
  firstName: string,
  userEmail: string,
  resetUrl: string,
  companyAddress: string,
  helpUrl: string,
) => `
<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Reset your password</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<style>
  table {border-collapse:collapse;}
  td,th,div,p,a,h1,h2,h3 {font-family:Arial, sans-serif;}
</style>
<![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; background-color: #f4f4f5; }

  .bg-body   { background-color: #f4f4f5; }
  .bg-card   { background-color: #ffffff; }
  .text-main { color: #18181b; }
  .text-sub  { color: #71717a; }
  .divider   { border-top: 1px solid #e4e4e7; }
  .btn-bg    { background-color: #18181b; }
  .btn-text  { color: #ffffff !important; }
  .code-box  { background-color: #f4f4f5; color: #18181b; }

  @media (prefers-color-scheme: dark) {
    .bg-body   { background-color: #09090b !important; }
    .bg-card   { background-color: #18181b !important; }
    .text-main { color: #fafafa !important; }
    .text-sub  { color: #a1a1aa !important; }
    .divider   { border-top: 1px solid #27272a !important; }
    .code-box  { background-color: #27272a !important; color: #fafafa !important; }
    .btn-bg    { background-color: #fafafa !important; }
    .btn-text  { color: #18181b !important; }
  }

  @media (prefers-color-scheme: dark) {
    a.btn:hover { background-color: #e4e4e7 !important; }
  }

  @media screen and (max-width: 600px) {
    .email-container { width: 100% !important; }
    .fluid-padding { padding-left: 20px !important; padding-right: 20px !important; }
    .h1-mobile { font-size: 22px !important; line-height: 28px !important; }
  }

  a.btn:hover { background-color: #27272a !important; }
</style>
</head>
<body class="bg-body" style="margin:0; padding:0; background-color:#f4f4f5;">
  <!-- Preheader (hidden preview text) -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    Reset your ${appName} password. This link expires in 15 minutes and can only be used once.
    &#847; &zwnj; &nbsp; &#8199; &#8203; &#847; &zwnj; &nbsp; &#8199; &#8203;
  </div>

  <center class="bg-body" style="width:100%; background-color:#f4f4f5;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="bg-body">
      <tr>
        <td align="center" style="padding: 32px 16px;">

          <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="email-container" style="width:600px; max-width:600px;">
            <!-- Logo -->
            <tr>
              <td align="center" style="padding-bottom: 24px;">
                <img src="https://your-cdn.example.com/logo.png" width="140" alt="YourApp" style="display:block; width:140px;">
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td class="bg-card" style="border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td class="fluid-padding" style="padding: 40px 48px 24px 48px;">
                      <h1 class="text-main h1-mobile" style="margin:0 0 16px 0; font-family:Arial,Helvetica,sans-serif; font-size:24px; line-height:30px; font-weight:700;">
                        Reset your password
                      </h1>
                      <p class="text-sub" style="margin:0 0 24px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px;">
                        Hi ${firstName}, we received a request to reset the password for
                        <strong class="text-main">${userEmail}</strong>. Click below to choose a new one.
                      </p>
                    </td>
                  </tr>

                  <!-- Bulletproof button -->
                  <tr>
                    <td class="fluid-padding" align="center" style="padding: 0 48px 24px 48px;">
                      <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${resetUrl}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="12%" fillcolor="#18181b" stroke="f">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Reset password</center>
                      </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-->
                      <a href="${resetUrl}" class="btn btn-bg btn-text" target="_blank"
                         style="background-color:#18181b; color:#ffffff; display:inline-block; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:700; line-height:48px; text-align:center; text-decoration:none; width:200px; border-radius:8px; -webkit-text-size-adjust:none;">
                        Reset password
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>

                  <tr>
                    <td class="fluid-padding" style="padding: 0 48px 32px 48px;">
                      <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        Or paste this link into your browser:<br>
                        <a href="${resetUrl}" class="text-main" style="text-decoration:underline; word-break:break-all;">${resetUrl}</a>
                      </p>
                    </td>
                  </tr>

                  <tr><td class="fluid-padding" style="padding: 0 48px;"><div class="divider"></div></td></tr>

                  <tr>
                    <td class="fluid-padding" style="padding: 24px 48px 40px 48px;">
                      <p class="text-sub" style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        This link expires in 15 minutes and can only be used once.
                      </p>
                      <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        Didn't request this? Your password is still safe — you can ignore this email, or
                        <a href="${helpUrl}" class="text-main" style="text-decoration:underline;">contact support</a> if you're concerned about account security.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding: 24px 20px;">
                <p class="text-sub" style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  ${appName}, ${companyAddress}
                </p>
                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  <a href="${helpUrl}" style="color:#71717a; text-decoration:underline;">Need help?</a>
                </p>
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </center>
</body>
</html>

`;

export const loginMail = (
  appName: string,
  otpCode: string,
  url: string,
  userEmail: string,
  companyAddress: string,
) => `
<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Your login code</title>
<!--[if mso]>
<style>table {border-collapse:collapse;} td,th,div,p,a,h1,h2,h3 {font-family:Arial, sans-serif;}</style>
<![endif]-->
<style>
  body { margin:0; padding:0; width:100% !important; background-color:#f4f4f5; }
  img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  .bg-body  { background-color:#f4f4f5; }
  .bg-card  { background-color:#ffffff; }
  .text-main{ color:#18181b; }
  .text-sub { color:#71717a; }
  .divider  { border-top:1px solid #e4e4e7; }
  .code-box { background-color:#f4f4f5; color:#18181b; border:1px dashed #d4d4d8; }
  .btn-bg   { background-color:#18181b; }
  .btn-text { color:#ffffff !important; }

  @media (prefers-color-scheme: dark) {
    .bg-body  { background-color:#09090b !important; }
    .bg-card  { background-color:#18181b !important; }
    .text-main{ color:#fafafa !important; }
    .text-sub { color:#a1a1aa !important; }
    .divider  { border-top:1px solid #27272a !important; }
    .code-box { background-color:#27272a !important; color:#fafafa !important; border:1px dashed #3f3f46 !important; }
    .btn-bg   { background-color:#fafafa !important; }
    .btn-text { color:#18181b !important; }
  }
  @media (prefers-color-scheme: dark) {
    a.btn:hover { background-color:#e4e4e7 !important; }
  }
  @media screen and (max-width:600px) {
    .email-container { width:100% !important; }
    .fluid-padding { padding-left:20px !important; padding-right:20px !important; }
  }
  a.btn:hover { background-color:#27272a !important; }
</style>
</head>
<body class="bg-body" style="margin:0; padding:0;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    Your one-time login code is ${otpCode}. It expires in 10 minutes.
    &#847; &zwnj; &nbsp; &#8199; &#8203; &#847; &zwnj; &nbsp; &#8199; &#8203;
  </div>

  <center class="bg-body" style="width:100%;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="bg-body">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="email-container" style="width:600px; max-width:600px;">
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <img src="https://your-cdn.example.com/logo.png" width="140" alt="YourApp" style="display:block; width:140px;">
              </td>
            </tr>

            <tr>
              <td class="bg-card" style="border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td class="fluid-padding" style="padding:40px 48px 8px 48px;" align="center">
                      <h1 class="text-main" style="margin:0 0 12px 0; font-family:Arial,Helvetica,sans-serif; font-size:22px; line-height:28px; font-weight:700;">
                        Your login code
                      </h1>
                      <p class="text-sub" style="margin:0 0 24px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:22px;">
                        Enter this code in ${appName} to finish signing in as ${userEmail}.
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td class="fluid-padding" align="center" style="padding:0 48px 24px 48px;">
                      <div class="code-box" style="display:inline-block; padding:16px 32px; border-radius:8px; font-family:'Courier New',Courier,monospace; font-size:32px; font-weight:700; letter-spacing:8px;">
                        ${otpCode}
                      </div>
                    </td>
                  </tr>

                  <tr>
                    <td class="fluid-padding" align="center" style="padding:0 48px 8px 48px;">
                      <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        This code expires in 10 minutes.
                      </p>
                    </td>
                  </tr>

                  <!-- Optional one-click alternative to typing the code -->
                  <tr>
                    <td class="fluid-padding" align="center" style="padding:16px 48px 24px 48px;">
                      <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="12%" fillcolor="#18181b" stroke="f">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">Or log in instantly</center>
                      </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-->
                      <a href="${url}" class="btn btn-bg btn-text" target="_blank"
                         style="background-color:#18181b; color:#ffffff !important; display:inline-block; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:700; line-height:44px; text-align:center; text-decoration:none; width:200px; border-radius:8px;">
                        Or log in instantly
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>

                  <tr><td class="fluid-padding" style="padding:0 48px;"><div class="divider"></div></td></tr>

                  <tr>
                    <td class="fluid-padding" style="padding:24px 48px 40px 48px;">
                      <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:20px;">
                        If you didn't try to log in, you can safely ignore this email — someone may have typo'd their own address.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:24px 20px;">
                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  ${appName}, ${companyAddress}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>

`;

export const welcomeMail = (
  appName: string,
  firstName: string,
  dashboardUrl: string,
  companyAddress: string,
) => `
<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Welcome to ${appName}</title>
<!--[if mso]><style>table {border-collapse:collapse;} td,th,div,p,a,h1,h2,h3 {font-family:Arial, sans-serif;}</style><![endif]-->
<style>
  body { margin:0; padding:0; width:100% !important; background-color:#f4f4f5; }
  img { border:0; height:auto; -ms-interpolation-mode:bicubic; }
  .bg-body  { background-color:#f4f4f5; }
  .bg-card  { background-color:#ffffff; }
  .text-main{ color:#18181b; }
  .text-sub { color:#71717a; }
  .divider  { border-top:1px solid #e4e4e7; }
  .step-num { background-color:#e4e4e7; color:#18181b; }
  .btn-bg   { background-color:#18181b; }
  .btn-text { color:#ffffff !important; }

  @media (prefers-color-scheme: dark) {
    .bg-body  { background-color:#09090b !important; }
    .bg-card  { background-color:#18181b !important; }
    .text-main{ color:#fafafa !important; }
    .text-sub { color:#a1a1aa !important; }
    .divider  { border-top:1px solid #27272a !important; }
    .step-num { background-color:#3f3f46 !important; color:#f4f4f5 !important; }
    .btn-bg   { background-color:#fafafa !important; }
    .btn-text { color:#18181b !important; }
  }
  @media (prefers-color-scheme: dark) {
    a.btn:hover { background-color:#e4e4e7 !important; }
  }
  @media screen and (max-width:600px) {
    .email-container { width:100% !important; }
    .fluid-padding { padding-left:20px !important; padding-right:20px !important; }
    .hero-img { height:auto !important; }
  }
  a.btn:hover { background-color:#27272a !important; }
</style>
</head>
<body class="bg-body" style="margin:0; padding:0;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    You're in! Here's how to get the most out of ${appName} in the next 5 minutes.
    &#847; &zwnj; &nbsp; &#8199; &#8203;
  </div>

  <center class="bg-body" style="width:100%;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="bg-body">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="email-container" style="width:600px; max-width:600px;">

            <tr>
              <td align="center" style="padding-bottom:24px;">
                <img src="https://your-cdn.example.com/logo.png" width="140" alt="YourApp" style="display:block; width:140px;">
              </td>
            </tr>

            <tr>
              <td class="bg-card" style="border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">

                <img src="https://your-cdn.example.com/welcome-hero.png" width="600" alt="" class="hero-img" style="display:block; width:100%; max-width:600px; height:200px; object-fit:cover;">

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td class="fluid-padding" style="padding:32px 48px 8px 48px;">
                      <h1 class="text-main" style="margin:0 0 12px 0; font-family:Arial,Helvetica,sans-serif; font-size:24px; line-height:30px; font-weight:700;">
                        Welcome, ${firstName} 👋
                      </h1>
                      <p class="text-sub" style="margin:0 0 24px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px;">
                        Your ${appName} account is ready. Here are three quick things to help you get set up.
                      </p>
                    </td>
                  </tr>

                  <!-- Step list -->
                  <tr>
                    <td class="fluid-padding" style="padding:0 48px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                          <td width="40" valign="top" style="padding-bottom:20px;">
                            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                              <td class="step-num" width="28" height="28" align="center" valign="middle" style="border-radius:50%; font-family:Arial,sans-serif; font-size:13px; font-weight:700;">1</td>
                            </tr></table>
                          </td>
                          <td valign="top" style="padding-bottom:20px; padding-left:8px;">
                            <p class="text-main" style="margin:0 0 2px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:700;">Complete your profile</p>
                            <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:20px;">Add a photo and a few details so your team recognizes you.</p>
                          </td>
                        </tr>
                        <tr>
                          <td width="40" valign="top" style="padding-bottom:20px;">
                            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                              <td class="step-num" width="28" height="28" align="center" valign="middle" style="border-radius:50%; font-family:Arial,sans-serif; font-size:13px; font-weight:700;">2</td>
                            </tr></table>
                          </td>
                          <td valign="top" style="padding-bottom:20px; padding-left:8px;">
                            <p class="text-main" style="margin:0 0 2px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:700;">Invite your team</p>
                            <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:20px;">${appName} works best when everyone's in the same workspace.</p>
                          </td>
                        </tr>
                        <tr>
                          <td width="40" valign="top">
                            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                              <td class="step-num" width="28" height="28" align="center" valign="middle" style="border-radius:50%; font-family:Arial,sans-serif; font-size:13px; font-weight:700;">3</td>
                            </tr></table>
                          </td>
                          <td valign="top" style="padding-left:8px;">
                            <p class="text-main" style="margin:0 0 2px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:700;">Connect your first integration</p>
                            <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:20px;">Pull in data from tools you already use.</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <tr>
                    <td class="fluid-padding" align="center" style="padding:28px 48px 40px 48px;">
                      <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${dashboardUrl}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="12%" fillcolor="#18181b" stroke="f">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Go to your dashboard</center>
                      </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-->
                      <a href="${dashboardUrl}" class="btn btn-bg btn-text" target="_blank"
                         style="background-color:#18181b; color:#ffffff !important; display:inline-block; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:700; line-height:48px; text-align:center; text-decoration:none; width:220px; border-radius:8px;">
                        Go to your dashboard
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:24px 20px;">
                <p class="text-sub" style="margin:0 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  Questions? Just reply to this email — a real person reads these.
                </p>
                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  ${appName}, ${companyAddress}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>

`;

// Marketing has too many moving parts for positional args — takes one object.
// (Same {...} → ${...} conversion as the others; just destructured up top.)
export const marketingMail = (params: {
  appName: string;
  companyAddress: string;
  campaignSubject: string;
  preheaderText: string;
  campaignTag: string;
  campaignHeadline: string;
  campaignBody: string;
  ctaLabel: string;
  ctaUrl: string;
  feature1Title: string;
  feature1Body: string;
  feature2Title: string;
  feature2Body: string;
  webViewUrl: string;
  preferencesUrl: string;
  unsubscribeUrl: string;
  socialTwitterUrl: string;
  socialLinkedinUrl: string;
}) => {
  const {
    appName,
    companyAddress,
    campaignSubject,
    preheaderText,
    campaignTag,
    campaignHeadline,
    campaignBody,
    ctaLabel,
    ctaUrl,
    feature1Title,
    feature1Body,
    feature2Title,
    feature2Body,
    webViewUrl,
    preferencesUrl,
    unsubscribeUrl,
    socialTwitterUrl,
    socialLinkedinUrl,
  } = params;

  return `
<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${campaignSubject}</title>
<!--[if mso]><style>table {border-collapse:collapse;} td,th,div,p,a,h1,h2,h3 {font-family:Arial, sans-serif;}</style><![endif]-->
<style>
  body { margin:0; padding:0; width:100% !important; background-color:#f4f4f5; }
  img { border:0; height:auto; -ms-interpolation-mode:bicubic; }
  .bg-body  { background-color:#f4f4f5; }
  .bg-card  { background-color:#ffffff; }
  .text-main{ color:#18181b; }
  .text-sub { color:#71717a; }
  .divider  { border-top:1px solid #e4e4e7; }
  .tag      { background-color:#e4e4e7; color:#18181b; }
  .card-2   { background-color:#fafafa; border:1px solid #e4e4e7; }
  .btn-bg   { background-color:#18181b; }
  .btn-text { color:#ffffff !important; }

  @media (prefers-color-scheme: dark) {
    .bg-body  { background-color:#09090b !important; }
    .bg-card  { background-color:#18181b !important; }
    .text-main{ color:#fafafa !important; }
    .text-sub { color:#a1a1aa !important; }
    .divider  { border-top:1px solid #27272a !important; }
    .tag      { background-color:#3f3f46 !important; color:#f4f4f5 !important; }
    .card-2   { background-color:#27272a !important; border:1px solid #3f3f46 !important; }
    .btn-bg   { background-color:#fafafa !important; }
    .btn-text { color:#18181b !important; }
  }
  @media (prefers-color-scheme: dark) {
    a.btn:hover { background-color:#e4e4e7 !important; }
  }
  @media screen and (max-width:600px) {
    .email-container { width:100% !important; }
    .fluid-padding { padding-left:20px !important; padding-right:20px !important; }
    .stack { display:block !important; width:100% !important; }
    .stack-pad { padding-bottom:16px !important; }
  }
  a.btn:hover { background-color:#27272a !important; }
</style>
</head>
<body class="bg-body" style="margin:0; padding:0;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    ${preheaderText}
    &#847; &zwnj; &nbsp; &#8199; &#8203;
  </div>

  <center class="bg-body" style="width:100%;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="bg-body">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="email-container" style="width:600px; max-width:600px;">

            <!-- Header / logo + view-in-browser -->
            <tr>
              <td style="padding-bottom:16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="left">
                      <img src="https://your-cdn.example.com/logo.png" width="120" alt="YourApp" style="display:block; width:120px;">
                    </td>
                    <td align="right">
                      <a href="${webViewUrl}" class="text-sub" style="font-family:Arial,Helvetica,sans-serif; font-size:12px; text-decoration:underline;">View in browser</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Hero -->
            <tr>
              <td class="bg-card" style="border-radius:12px 12px 0 0; overflow:hidden;">
                <img src="https://your-cdn.example.com/campaign-hero.png" width="600" alt="" style="display:block; width:100%; max-width:600px;">
              </td>
            </tr>

            <tr>
              <td class="bg-card" style="box-shadow:0 1px 3px rgba(0,0,0,0.06);">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td class="fluid-padding" style="padding:32px 48px 8px 48px;">
                      <span class="tag" style="display:inline-block; padding:4px 10px; border-radius:999px; font-family:Arial,Helvetica,sans-serif; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;">${campaignTag}</span>
                      <h1 class="text-main" style="margin:16px 0 12px 0; font-family:Arial,Helvetica,sans-serif; font-size:24px; line-height:30px; font-weight:700;">
                        ${campaignHeadline}
                      </h1>
                      <p class="text-sub" style="margin:0 0 24px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px;">
                        ${campaignBody}
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td class="fluid-padding" align="center" style="padding:0 48px 32px 48px;">
                      <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${ctaUrl}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="12%" fillcolor="#18181b" stroke="f">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${ctaLabel}</center>
                      </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-->
                      <a href="${ctaUrl}" class="btn btn-bg btn-text" target="_blank"
                         style="background-color:#18181b; color:#ffffff !important; display:inline-block; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:700; line-height:48px; text-align:center; text-decoration:none; width:220px; border-radius:8px;">
                        ${ctaLabel}
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>

                  <tr><td class="fluid-padding" style="padding:0 48px;"><div class="divider"></div></td></tr>

                  <!-- Two-up secondary content, stacks on mobile -->
                  <tr>
                    <td class="fluid-padding" style="padding:28px 48px 32px 48px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td class="stack" width="48%" valign="top" style="padding-right:2%;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card-2" style="border-radius:8px;">
                              <tr><td style="padding:16px;">
                                <p class="text-main" style="margin:0 0 4px 0; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:700;">${feature1Title}</p>
                                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:18px;">${feature1Body}</p>
                              </td></tr>
                            </table>
                          </td>
                          <td class="stack stack-pad" width="48%" valign="top" style="padding-left:2%;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card-2" style="border-radius:8px;">
                              <tr><td style="padding:16px;">
                                <p class="text-main" style="margin:0 0 4px 0; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:700;">${feature2Title}</p>
                                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:18px;">${feature2Body}</p>
                              </td></tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- CAN-SPAM / GDPR compliant footer -->
            <tr>
              <td align="center" style="padding:24px 20px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:0 6px;"><a href="${socialTwitterUrl}"><img src="https://your-cdn.example.com/icon-x.png" width="20" height="20" alt="X"></a></td>
                    <td style="padding:0 6px;"><a href="${socialLinkedinUrl}"><img src="https://your-cdn.example.com/icon-linkedin.png" width="20" height="20" alt="LinkedIn"></a></td>
                  </tr>
                </table>
                <p class="text-sub" style="margin:16px 0 8px 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  ${appName}, ${companyAddress}
                </p>
                <p class="text-sub" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px;">
                  You're receiving this because you're a ${appName} user.
                  <a href="${preferencesUrl}" style="color:#71717a; text-decoration:underline;">Manage preferences</a>
                  &nbsp;·&nbsp;
                  <a href="${unsubscribeUrl}" style="color:#71717a; text-decoration:underline;">Unsubscribe</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>
`;
};
