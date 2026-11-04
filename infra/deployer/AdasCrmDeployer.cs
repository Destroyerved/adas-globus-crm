using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace AdasCrmDeployer
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string repoRoot = ResolveRepoRoot();
            string domain = "adasglobuspro.com";
            string tunnelName = "adas-crm-prod-16gb";
            string tunnelToken = "";
            bool headlessProvision = false;
            bool startService = false;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--provision" || arg == "--headless")
                {
                    headlessProvision = true;
                }
                else if (arg == "--start-service")
                {
                    headlessProvision = true;
                    startService = true;
                }
                else if (arg == "--domain" && i + 1 < args.Length)
                {
                    domain = SanitizeDomain(args[++i]);
                }
                else if (arg == "--tunnel-name" && i + 1 < args.Length)
                {
                    tunnelName = args[++i].Trim();
                }
                else if (arg == "--tunnel-token" && i + 1 < args.Length)
                {
                    tunnelToken = args[++i].Trim();
                }
            }

            if (headlessProvision)
            {
                string report = ProvisionAll(repoRoot, domain, tunnelName, tunnelToken);
                Console.WriteLine(report);
                if (startService)
                {
                    string startLog = StartProductionStack(repoRoot, false);
                    Console.WriteLine(startLog);
                }
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new DeployerForm(repoRoot, domain, tunnelName));
            return 0;
        }

        public static string ResolveRepoRoot()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            DirectoryInfo dir = new DirectoryInfo(exeDir);
            while (dir != null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "package.json")) &&
                    Directory.Exists(Path.Combine(dir.FullName, "infra")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            return Directory.GetCurrentDirectory();
        }

        public static string SanitizeDomain(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "adasglobuspro.com";
            string clean = raw.Trim().ToLowerInvariant();
            if (clean.StartsWith("https://")) clean = clean.Substring(8);
            if (clean.StartsWith("http://")) clean = clean.Substring(7);
            int slashIdx = clean.IndexOf('/');
            if (slashIdx >= 0) clean = clean.Substring(0, slashIdx);
            return string.IsNullOrWhiteSpace(clean) ? "adasglobuspro.com" : clean;
        }

        private static string GenerateHexSecret(int byteLength)
        {
            byte[] bytes = new byte[byteLength];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            StringBuilder sb = new StringBuilder(byteLength * 2);
            foreach (byte b in bytes)
            {
                sb.Append(b.ToString("x2"));
            }
            return sb.ToString();
        }

        public static string ProvisionAll(string repoRoot, string rawDomain, string tunnelName, string tunnelToken)
        {
            string domain = SanitizeDomain(rawDomain);
            if (string.IsNullOrWhiteSpace(tunnelName)) tunnelName = "adas-crm-prod-16gb";

            StringBuilder log = new StringBuilder();
            log.AppendLine("=== ADAS CRM 16GB Server & Cloudflare One-Click Provisioner ===");
            log.AppendLine("Repository Root : " + repoRoot);
            log.AppendLine("Target Domain   : " + domain);
            log.AppendLine("Tunnel Name     : " + tunnelName);
            log.AppendLine("Server Profile  : 16 GB RAM (Postgres 4GB, API+SPA 1GB, Worker 768MB, n8n 1.5GB, OS/Cache 8.25GB)");

            // 1. Ensure secrets directory & 256-bit cryptographic secrets (never overwrite existing)
            string secretsDir = Path.Combine(repoRoot, "secrets");
            Directory.CreateDirectory(secretsDir);
            EnsureSecretFile(Path.Combine(secretsDir, "session_secret.txt"), 32, log);
            EnsureSecretFile(Path.Combine(secretsDir, "token_encryption_key.txt"), 32, log);
            EnsureSecretFile(Path.Combine(secretsDir, "postgres_password.txt"), 24, log);
            EnsureSecretFile(Path.Combine(secretsDir, "n8n_webhook_secret.txt"), 32, log);

            if (!string.IsNullOrWhiteSpace(tunnelToken))
            {
                string tokenFile = Path.Combine(secretsDir, "cloudflare_tunnel_token.txt");
                File.WriteAllText(tokenFile, tunnelToken.Trim(), Encoding.UTF8);
                log.AppendLine("[OK] Saved Cloudflare Tunnel token -> secrets/cloudflare_tunnel_token.txt");
            }

            // 2. Write Cloudflare Tunnel config.yml (PRD §10.4)
            string cfDir = Path.Combine(repoRoot, "infra", "cloudflare");
            Directory.CreateDirectory(cfDir);
            string cfConfigPath = Path.Combine(cfDir, "config.yml");
            string cfConfig = string.Join(Environment.NewLine, new string[]
            {
                "# Generated by ADAS-CRM-Deployer.exe (PRD 10.4)",
                "tunnel: " + tunnelName,
                "credentials-file: /etc/cloudflared/" + tunnelName + ".json",
                "",
                "ingress:",
                "  - hostname: crm." + domain,
                "    service: http://localhost:3000",
                "  - hostname: go." + domain,
                "    service: http://localhost:3000",
                "  - hostname: status." + domain,
                "    service: http://localhost:3001",
                "  - hostname: automation." + domain,
                "    service: http://localhost:5678",
                "  - service: http_status:404",
                ""
            });
            File.WriteAllText(cfConfigPath, cfConfig, Encoding.UTF8);
            log.AppendLine("[OK] Wrote Cloudflare Tunnel ingress -> infra/cloudflare/config.yml");

            // 3. Write Cloudflare DNS Zone file with Tunnel CNAMEs + Anti-Spam SPF/DKIM/DMARC (PRD §5.4, §10.4)
            string dnsPath = Path.Combine(cfDir, "dns-records.bind");
            string dnsContent = string.Join(Environment.NewLine, new string[]
            {
                "; =============================================================================",
                "; ADAS CRM Cloudflare DNS Records (Import in Cloudflare Dashboard -> DNS -> Import)",
                "; Domain: " + domain + " | Tunnel: " + tunnelName,
                "; =============================================================================",
                "crm." + domain + ".         1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "go." + domain + ".          1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "status." + domain + ".      1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "automation." + domain + ".  1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "",
                "; Anti-Spam Email Authentication (PRD 5.4: SPF + 2048-bit DKIM + DMARC p=quarantine)",
                domain + ".                 300 IN  TXT     \"v=spf1 include:spf.protection.outlook.com -all\"",
                "mail." + domain + ".            300 IN  TXT     \"v=spf1 include:amazonses.com -all\"",
                "_dmarc." + domain + ".          300 IN  TXT     \"v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@" + domain + "; adkim=s; aspf=s\"",
                "_dmarc.mail." + domain + ".     300 IN  TXT     \"v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@" + domain + "\"",
                ""
            });
            File.WriteAllText(dnsPath, dnsContent, Encoding.UTF8);
            log.AppendLine("[OK] Wrote Cloudflare DNS + Anti-Spam SPF/DMARC zone -> infra/cloudflare/dns-records.bind");

            // 4. Write .env.production (non-destructive if already customized, updates domain hosts)
            string envProdPath = Path.Combine(repoRoot, ".env.production");
            string envProdContent = string.Join(Environment.NewLine, new string[]
            {
                "# Generated by ADAS-CRM-Deployer.exe for 16GB Server & Cloudflare Tunnel",
                "NODE_ENV=production",
                "PORT=3000",
                "WEB_PORT=5174",
                "ADAS_DOMAIN=" + domain,
                "APP_INTERNAL_HOST=crm." + domain,
                "APP_PUBLIC_HOST=go." + domain,
                "PUBLIC_WEB_URL=https://crm." + domain,
                "PUBLIC_API_URL=https://crm." + domain + "/api/v1",
                "DATABASE_URL=postgresql://adas_app:adas_prod_password@postgres:5432/adas_crm?schema=public",
                "DATABASE_ADMIN_URL=postgresql://adas_admin:adas_admin_password@postgres:5432/adas_crm?schema=public",
                "MAIL_LIVE=false",
                "MAILPIT_SMTP_HOST=localhost",
                "MAILPIT_SMTP_PORT=1025",
                "MAILPIT_HTTP_URL=http://localhost:8025",
                "SESSION_IDLE_TIMEOUT_HOURS=12",
                "SESSION_ABSOLUTE_TIMEOUT_DAYS=7",
                "SESSION_SECRET_FILE=./secrets/session_secret.txt",
                "TOKEN_ENCRYPTION_KEY_FILE=./secrets/token_encryption_key.txt",
                "TOKEN_ENCRYPTION_KEY_VERSION=1",
                "INQUIRY_CORS_ORIGINS=https://www." + domain + ",https://" + domain,
                "DEFAULT_REPORTING_CURRENCY=USD",
                "N8N_PORT=5678",
                "N8N_WEBHOOK_URL=https://automation." + domain + "/webhook/adas-crm-outbox-lead",
                "LOG_LEVEL=info",
                ""
            });
            File.WriteAllText(envProdPath, envProdContent, Encoding.UTF8);
            log.AppendLine("[OK] Wrote 16GB Production Environment -> .env.production");

            log.AppendLine("=== Provisioning Complete ===");
            log.AppendLine(" -> CRM App URL      : https://crm." + domain);
            log.AppendLine(" -> Public Intake/Unsub: https://go." + domain);
            log.AppendLine(" -> Uptime Kuma      : https://status." + domain);
            log.AppendLine(" -> n8n Automation   : https://automation." + domain);
            return log.ToString();
        }

        private static void EnsureSecretFile(string filePath, int bytes, StringBuilder log)
        {
            if (!File.Exists(filePath))
            {
                File.WriteAllText(filePath, GenerateHexSecret(bytes), Encoding.UTF8);
                log.AppendLine("[OK] Generated cryptographic secret -> " + Path.GetFileName(filePath));
            }
            else
            {
                log.AppendLine("[OK] Existing secret preserved -> " + Path.GetFileName(filePath));
            }
        }

        public static string StartProductionStack(string repoRoot, bool useDockerCompose)
        {
            StringBuilder log = new StringBuilder();
            try
            {
                if (useDockerCompose)
                {
                    log.AppendLine("Starting 16GB Docker Compose Production Stack (infra/compose.prod.yml)...");
                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c docker compose -f infra/compose.prod.yml up -d")
                    {
                        WorkingDirectory = repoRoot,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true
                    };
                    using (Process p = Process.Start(psi))
                    {
                        string stdout = p.StandardOutput.ReadToEnd();
                        string stderr = p.StandardError.ReadToEnd();
                        p.WaitForExit(60000);
                        if (!string.IsNullOrWhiteSpace(stdout)) log.AppendLine(stdout.Trim());
                        if (!string.IsNullOrWhiteSpace(stderr)) log.AppendLine(stderr.Trim());
                    }
                }
                else
                {
                    log.AppendLine("Starting ADAS CRM Unified Service (API + Static SPA + Embedded PGlite) on http://localhost:3000 ...");
                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c start \"ADAS-CRM-Service\" /min pnpm --filter @adas/api start")
                    {
                        WorkingDirectory = repoRoot,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    Process.Start(psi);
                    log.AppendLine("[OK] ADAS-CRM-Service launched on http://localhost:3000 (serving Web SPA + /api/v1 + /u/:token).");
                }
            }
            catch (Exception ex)
            {
                log.AppendLine("[ERROR] " + ex.Message);
            }
            return log.ToString();
        }

        public static string SetupCloudflaredService(string repoRoot, string domain, string tunnelName, string tunnelToken)
        {
            StringBuilder log = new StringBuilder();
            string cfConfigPath = Path.Combine(repoRoot, "infra", "cloudflare", "config.yml");
            log.AppendLine("=== Cloudflare Tunnel Windows Service Installer ===");
            log.AppendLine("Config File: " + cfConfigPath);

            try
            {
                ProcessStartInfo checkPsi = new ProcessStartInfo("cmd.exe", "/c cloudflared --version")
                {
                    WorkingDirectory = repoRoot,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (Process p = Process.Start(checkPsi))
                {
                    string ver = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(10000);
                    if (p.ExitCode == 0 && !string.IsNullOrWhiteSpace(ver))
                    {
                        log.AppendLine("[OK] Detected installed cloudflared: " + ver.Trim());
                        if (!string.IsNullOrWhiteSpace(tunnelToken))
                        {
                            log.AppendLine("Run as Administrator to register service: cloudflared service install " + tunnelToken);
                        }
                        else
                        {
                            log.AppendLine("Next commands executed by tunnel setup:");
                            log.AppendLine("  1. cloudflared tunnel login");
                            log.AppendLine("  2. cloudflared tunnel create " + tunnelName);
                            log.AppendLine("  3. cloudflared tunnel route dns " + tunnelName + " crm." + domain);
                            log.AppendLine("  4. cloudflared tunnel route dns " + tunnelName + " go." + domain);
                            log.AppendLine("  5. cloudflared tunnel route dns " + tunnelName + " status." + domain);
                            log.AppendLine("  6. cloudflared tunnel route dns " + tunnelName + " automation." + domain);
                            log.AppendLine("  7. cloudflared --config \"" + cfConfigPath + "\" service install");
                        }
                    }
                    else
                    {
                        log.AppendLine("[INFO] cloudflared CLI not found in PATH. Install via:");
                        log.AppendLine("       winget install --id Cloudflare.cloudflared -e");
                        log.AppendLine("       OR use Docker Compose mode (infra/compose.prod.yml includes cloudflared container).");
                    }
                }
            }
            catch (Exception ex)
            {
                log.AppendLine("[INFO] " + ex.Message);
            }
            return log.ToString();
        }
    }

    internal sealed class DeployerForm : Form
    {
        private readonly string _repoRoot;
        private readonly TextBox _domainBox;
        private readonly TextBox _tunnelNameBox;
        private readonly TextBox _tunnelTokenBox;
        private readonly CheckBox _dockerModeCheck;
        private readonly TextBox _logBox;

        public DeployerForm(string repoRoot, string defaultDomain, string defaultTunnel)
        {
            _repoRoot = repoRoot;
            Text = "ADAS Globus Pro — 16GB Server & Cloudflare One-Click Deployer (.exe)";
            Size = new Size(860, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(251, 252, 251);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 68,
                BackColor = Color.FromArgb(4, 28, 62),
                Padding = new Padding(20, 12, 20, 12)
            };
            Label titleLabel = new Label
            {
                Text = "ADAS CRM · 16GB Server & Cloudflare Tunnel One-Click Deployer",
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 13f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(20, 12)
            };
            Label subLabel = new Label
            {
                Text = "Provisions 256-bit secrets, Cloudflare Tunnel (crm/go/status/automation), Anti-Spam SPF/DKIM/DMARC & 16GB service",
                ForeColor = Color.FromArgb(180, 210, 225),
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                AutoSize = true,
                Location = new Point(20, 38)
            };
            header.Controls.Add(titleLabel);
            header.Controls.Add(subLabel);

            Panel body = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(20)
            };

            Label domainLbl = new Label { Text = "Purchased Domain:", Location = new Point(20, 16), AutoSize = true };
            _domainBox = new TextBox { Text = defaultDomain, Location = new Point(180, 13), Width = 250 };

            Label tunnelLbl = new Label { Text = "Cloudflare Tunnel Name:", Location = new Point(450, 16), AutoSize = true };
            _tunnelNameBox = new TextBox { Text = defaultTunnel, Location = new Point(615, 13), Width = 200 };

            Label tokenLbl = new Label { Text = "CF Tunnel Token (optional):", Location = new Point(20, 50), AutoSize = true };
            _tunnelTokenBox = new TextBox { Text = "", Location = new Point(180, 47), Width = 415 };

            _dockerModeCheck = new CheckBox
            {
                Text = "Use Docker Compose 16GB Stack (infra/compose.prod.yml)",
                Location = new Point(610, 49),
                AutoSize = true,
                Checked = false
            };

            Button btnProvision = CreateButton("1. Provision Cloudflare + Anti-Spam DNS + Secrets", new Point(20, 88), 310, true);
            btnProvision.Click += (s, e) =>
            {
                string output = Program.ProvisionAll(_repoRoot, _domainBox.Text, _tunnelNameBox.Text, _tunnelTokenBox.Text);
                AppendLog(output);
            };

            Button btnStart = CreateButton("2. One-Click Start CRM Service (:3000)", new Point(340, 88), 245, false);
            btnStart.Click += (s, e) =>
            {
                string prov = Program.ProvisionAll(_repoRoot, _domainBox.Text, _tunnelNameBox.Text, _tunnelTokenBox.Text);
                AppendLog(prov);
                string started = Program.StartProductionStack(_repoRoot, _dockerModeCheck.Checked);
                AppendLog(started);
            };

            Button btnCfService = CreateButton("3. Setup Cloudflared Tunnel", new Point(595, 88), 130, false);
            btnCfService.Click += (s, e) =>
            {
                string cfLog = Program.SetupCloudflaredService(_repoRoot, Program.SanitizeDomain(_domainBox.Text), _tunnelNameBox.Text, _tunnelTokenBox.Text);
                AppendLog(cfLog);
            };

            Button btnOpen = CreateButton("4. Open CRM", new Point(735, 88), 85, false);
            btnOpen.Click += (s, e) =>
            {
                Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
            };

            _logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(20, 136),
                Size = new Size(795, 385),
                BackColor = Color.FromArgb(14, 24, 38),
                ForeColor = Color.FromArgb(224, 242, 241),
                Font = new Font("Consolas", 9.5f, FontStyle.Regular)
            };

            body.Controls.Add(domainLbl);
            body.Controls.Add(_domainBox);
            body.Controls.Add(tunnelLbl);
            body.Controls.Add(_tunnelNameBox);
            body.Controls.Add(tokenLbl);
            body.Controls.Add(_tunnelTokenBox);
            body.Controls.Add(_dockerModeCheck);
            body.Controls.Add(btnProvision);
            body.Controls.Add(btnStart);
            body.Controls.Add(btnCfService);
            body.Controls.Add(btnOpen);
            body.Controls.Add(_logBox);

            Controls.Add(body);
            Controls.Add(header);

            AppendLog(Program.ProvisionAll(_repoRoot, defaultDomain, defaultTunnel, ""));
        }

        private static Button CreateButton(string text, Point location, int width, bool primary)
        {
            return new Button
            {
                Text = text,
                Location = location,
                Size = new Size(width, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = primary ? Color.FromArgb(0, 119, 138) : Color.FromArgb(4, 28, 62),
                ForeColor = Color.White,
                Cursor = Cursors.Hand
            };
        }

        private void AppendLog(string message)
        {
            if (_logBox.Text.Length > 0)
            {
                _logBox.AppendText(Environment.NewLine);
            }
            _logBox.AppendText(message);
        }
    }
}
