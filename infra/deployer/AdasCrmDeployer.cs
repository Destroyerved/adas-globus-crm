using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace AdasCrmDeployer
{
    internal static class Program
    {
        public const string PurgeConfirmationPhrase = "DELETE ALL CRM DATA";

        [STAThread]
        private static int Main(string[] args)
        {
            string repoRoot = ResolveRepoRoot();
            string domain = "adasglobuspro.com";
            string tunnelName = "adas-crm-prod-16gb";
            string tunnelToken = "";
            string imageTag = "v1.0.0";
            string confirmPhrase = "";
            bool purgeData = false;
            string mode = "gui";

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--preflight") mode = "preflight";
                else if (arg == "--provision" || arg == "--headless") mode = "provision";
                else if (arg == "--start-service" || arg == "--install") mode = "install";
                else if (arg == "--health") mode = "health";
                else if (arg == "--rollback") mode = "rollback";
                else if (arg == "--uninstall") mode = "uninstall";
                else if (arg == "--purge-data") purgeData = true;
                else if (arg == "--confirm" && i + 1 < args.Length) confirmPhrase = args[++i];
                else if (arg == "--domain" && i + 1 < args.Length) domain = SanitizeDomain(args[++i]);
                else if (arg == "--tunnel-name" && i + 1 < args.Length) tunnelName = args[++i].Trim();
                else if (arg == "--tunnel-token" && i + 1 < args.Length) tunnelToken = args[++i].Trim();
                else if (arg == "--tag" && i + 1 < args.Length) imageTag = args[++i].Trim();
            }

            if (mode == "preflight")
            {
                Console.WriteLine(RunPreflightReport(repoRoot));
                return 0;
            }
            if (mode == "provision")
            {
                Console.WriteLine(ProvisionAll(repoRoot, domain, tunnelName, tunnelToken));
                return 0;
            }
            if (mode == "install")
            {
                Console.WriteLine(ProvisionAll(repoRoot, domain, tunnelName, tunnelToken));
                Console.WriteLine(StartProductionStack(repoRoot, imageTag));
                return 0;
            }
            if (mode == "health")
            {
                Console.WriteLine(CheckHealthEndpoint("http://127.0.0.1:3000/healthz"));
                return 0;
            }
            if (mode == "rollback")
            {
                Console.WriteLine(RollbackStack(repoRoot));
                return 0;
            }
            if (mode == "uninstall")
            {
                Console.WriteLine(UninstallStack(repoRoot, purgeData, confirmPhrase));
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

        private static string GenerateHexSecret(string prefix, int byteLength)
        {
            byte[] bytes = new byte[byteLength];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            StringBuilder sb = new StringBuilder(prefix.Length + byteLength * 2);
            sb.Append(prefix);
            foreach (byte b in bytes)
            {
                sb.Append(b.ToString("x2"));
            }
            return sb.ToString();
        }

        public static string RunPreflightReport(string repoRoot)
        {
            StringBuilder log = new StringBuilder();
            log.AppendLine("=== ADAS CRM Preflight Verification ===");
            log.AppendLine("OS Version      : " + Environment.OSVersion + (Environment.Is64BitOperatingSystem ? " (x64)" : " (x86)"));
            log.AppendLine("CPU Threads     : " + Environment.ProcessorCount);

            try
            {
                string rootDrive = Path.GetPathRoot(Path.GetFullPath(repoRoot));
                DriveInfo drive = new DriveInfo(rootDrive);
                double freeGb = Math.Round(drive.AvailableFreeSpace / (1024.0 * 1024.0 * 1024.0), 1);
                log.AppendLine("Free Disk Space : " + freeGb + " GB on " + rootDrive + (freeGb >= 20 ? " [PASS]" : " [WARN: 20+ GB recommended]"));
            }
            catch (Exception ex)
            {
                log.AppendLine("Free Disk Space : [WARN] " + ex.Message);
            }

            bool port3000Free = IsLoopbackPortFree(3000);
            log.AppendLine("Port 127.0.0.1:3000 : " + (port3000Free ? "[PASS] Available" : "[WARN] Already bound"));

            string dockerVer = RunShortCommand(repoRoot, "docker compose version --short");
            if (!string.IsNullOrWhiteSpace(dockerVer))
            {
                log.AppendLine("Docker Compose  : [PASS] v" + dockerVer);
            }
            else
            {
                log.AppendLine("Docker Compose  : [WARN] Docker Desktop / Compose v2 not currently running");
            }
            return log.ToString();
        }

        private static bool IsLoopbackPortFree(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (listener != null) listener.Stop();
            }
        }

        public static string ProvisionAll(string repoRoot, string rawDomain, string tunnelName, string tunnelToken)
        {
            string domain = SanitizeDomain(rawDomain);
            if (string.IsNullOrWhiteSpace(tunnelName)) tunnelName = "adas-crm-prod-16gb";

            StringBuilder log = new StringBuilder();
            log.AppendLine("=== ADAS CRM Production Provisioner (Idempotent & Non-Destructive) ===");
            log.AppendLine("Repository Root : " + repoRoot);
            log.AppendLine("Target Domain   : " + domain);
            log.AppendLine("Tunnel Name     : " + tunnelName);

            string secretsDir = Path.Combine(repoRoot, "secrets");
            Directory.CreateDirectory(secretsDir);
            Directory.CreateDirectory(Path.Combine(repoRoot, "data", "files"));
            Directory.CreateDirectory(Path.Combine(repoRoot, "data", "backups"));

            EnsureSecretFile(Path.Combine(secretsDir, "postgres_admin_password.txt"), "pgadm_", 24, log);
            EnsureSecretFile(Path.Combine(secretsDir, "postgres_app_password.txt"), "pgapp_", 24, log);
            EnsureSecretFile(Path.Combine(secretsDir, "session_secret.txt"), "sess_", 32, log);
            EnsureSecretFile(Path.Combine(secretsDir, "token_encryption_key.txt"), "tkey_", 32, log);
            EnsureSecretFile(Path.Combine(secretsDir, "backup_encryption_key.txt"), "bkey_", 32, log);

            if (!string.IsNullOrWhiteSpace(tunnelToken))
            {
                string tokenFile = Path.Combine(secretsDir, "cloudflare_tunnel_token.txt");
                File.WriteAllText(tokenFile, tunnelToken.Trim() + Environment.NewLine, Encoding.UTF8);
                log.AppendLine("[OK] Saved Cloudflare Tunnel token -> secrets/cloudflare_tunnel_token.txt");
            }

            string adminPw = Uri.EscapeDataString(File.ReadAllText(Path.Combine(secretsDir, "postgres_admin_password.txt"), Encoding.UTF8).Trim());
            string appPw = Uri.EscapeDataString(File.ReadAllText(Path.Combine(secretsDir, "postgres_app_password.txt"), Encoding.UTF8).Trim());

            string cfDir = Path.Combine(repoRoot, "infra", "cloudflare");
            Directory.CreateDirectory(cfDir);
            string cfConfigPath = Path.Combine(cfDir, "config.yml");
            string cfConfig = string.Join("\n", new string[]
            {
                "# ADAS CRM — Outbound Cloudflare Tunnel Ingress (PRD 10.4)",
                "tunnel: " + tunnelName,
                "credentials-file: /etc/cloudflared/credentials.json",
                "",
                "ingress:",
                "  - hostname: crm." + domain,
                "    service: http://api:3000",
                "  - hostname: go." + domain,
                "    service: http://api:3000",
                "  - hostname: status." + domain,
                "    service: http://uptime-kuma:3001",
                "  - service: http_status:404",
                ""
            });
            File.WriteAllText(cfConfigPath, cfConfig, Encoding.UTF8);
            log.AppendLine("[OK] Wrote Cloudflare Tunnel ingress -> infra/cloudflare/config.yml");

            string dnsPath = Path.Combine(cfDir, "dns-records.bind");
            string dnsContent = string.Join("\n", new string[]
            {
                "; =============================================================================",
                "; ADAS CRM Cloudflare DNS Records + Anti-Spam SPF/DMARC (PRD 5.4, 10.4)",
                "; Domain: " + domain + " | Tunnel: " + tunnelName,
                "; =============================================================================",
                "crm." + domain + ".         1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "go." + domain + ".          1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "status." + domain + ".      1   IN  CNAME   " + tunnelName + ".cfargotunnel.com.",
                "",
                "; Anti-Spam Email Authentication (SPF + DMARC p=quarantine)",
                domain + ".                 300 IN  TXT     \"v=spf1 include:spf.protection.outlook.com -all\"",
                "mail." + domain + ".            300 IN  TXT     \"v=spf1 ~all\"",
                "_dmarc." + domain + ".          300 IN  TXT     \"v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@" + domain + "; adkim=s; aspf=s\"",
                "_dmarc.mail." + domain + ".     300 IN  TXT     \"v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@" + domain + "\"",
                ""
            });
            File.WriteAllText(dnsPath, dnsContent, Encoding.UTF8);
            log.AppendLine("[OK] Wrote Cloudflare DNS + SPF/DMARC zone -> infra/cloudflare/dns-records.bind");

            string envProdPath = Path.Combine(repoRoot, ".env.production");
            string mailLive = "false";
            string keyVersion = "1";
            if (File.Exists(envProdPath))
            {
                File.Copy(envProdPath, envProdPath + ".bak", true);
                foreach (string line in File.ReadAllLines(envProdPath, Encoding.UTF8))
                {
                    if (line.Trim() == "MAIL_LIVE=true") mailLive = "true";
                    if (line.StartsWith("TOKEN_ENCRYPTION_KEY_VERSION="))
                    {
                        keyVersion = line.Substring("TOKEN_ENCRYPTION_KEY_VERSION=".Length).Trim();
                    }
                }
                log.AppendLine("[OK] Backed up existing .env.production -> .env.production.bak");
            }

            string envProdContent = string.Join("\n", new string[]
            {
                "# =============================================================================",
                "# ADAS CRM — Production Environment (.env.production)",
                "# Generated idempotently by ADAS-CRM-Deployer.exe",
                "# =============================================================================",
                "NODE_ENV=production",
                "PORT=3000",
                "WEB_PORT=5174",
                "ADAS_DOMAIN=" + domain,
                "APP_INTERNAL_HOST=crm." + domain,
                "APP_PUBLIC_HOST=go." + domain,
                "PUBLIC_WEB_URL=https://crm." + domain,
                "PUBLIC_API_URL=https://crm." + domain + "/api/v1",
                "DATABASE_URL=postgresql://adas_app:" + appPw + "@postgres:5432/adas_crm?schema=public",
                "DATABASE_ADMIN_URL=postgresql://adas_admin:" + adminPw + "@postgres:5432/adas_crm?schema=public",
                "MAIL_LIVE=" + mailLive,
                "SESSION_IDLE_TIMEOUT_HOURS=12",
                "SESSION_ABSOLUTE_TIMEOUT_DAYS=7",
                "SESSION_SECRET_FILE=/app/secrets/session_secret.txt",
                "TOKEN_ENCRYPTION_KEY_FILE=/app/secrets/token_encryption_key.txt",
                "TOKEN_ENCRYPTION_KEY_VERSION=" + keyVersion,
                "ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000",
                "ENTRA_CLIENT_ID=00000000-0000-0000-0000-000000000000",
                "ENTRA_CLIENT_SECRET_FILE=/app/secrets/entra_client_secret.txt",
                "ENTRA_REDIRECT_URI=https://crm." + domain + "/api/v1/auth/sso/callback",
                "ENTRA_MAIL_REDIRECT_URI=https://crm." + domain + "/api/v1/inbox/oauth/callback",
                "CRM_NOTIFICATION_MAILBOX=crm@" + domain,
                "ESP_PROVIDER=postmark",
                "ESP_SENDING_DOMAIN=mail." + domain,
                "ESP_API_KEY_FILE=/app/secrets/esp_api_key.txt",
                "ESP_WEBHOOK_SECRET_FILE=/app/secrets/esp_webhook_secret.txt",
                "APOLLO_API_KEY_FILE=/app/secrets/apollo_api_key.txt",
                "BOOKINGS_WEBHOOK_SECRET_FILE=/app/secrets/bookings_webhook_secret.txt",
                "WEBHOOK_ALLOW_PRIVATE_TARGETS=false",
                "CF_ACCESS_TEAM_DOMAIN=adasglobuspro.cloudflareaccess.com",
                "CF_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000",
                "CF_ACCESS_ENFORCE=false",
                "FILE_STORAGE_DRIVER=local",
                "FILE_STORAGE_LOCAL_PATH=/app/data/files",
                "INQUIRY_CORS_ORIGINS=https://www." + domain + ",https://" + domain,
                "INQUIRY_RATE_LIMIT_PER_10M=5",
                "API_RATE_LIMIT_PER_MIN=600",
                "DEFAULT_REPORTING_CURRENCY=USD",
                "BACKUP_LOCAL_DIR=/app/data/backups",
                "BACKUP_ENCRYPTION_KEY_FILE=/app/secrets/backup_encryption_key.txt",
                "BACKUP_RETENTION_DAYS=14",
                "BACKUP_S3_REGION=auto",
                "BACKUP_S3_SECRET_ACCESS_KEY_FILE=/app/secrets/backup_s3_secret_key.txt",
                "LOG_LEVEL=info",
                ""
            });
            File.WriteAllText(envProdPath, envProdContent, Encoding.UTF8);
            log.AppendLine("[OK] Wrote least-privilege production config -> .env.production");
            return log.ToString();
        }

        private static void EnsureSecretFile(string filePath, string prefix, int bytes, StringBuilder log)
        {
            if (!File.Exists(filePath) || File.ReadAllText(filePath, Encoding.UTF8).Trim().Length < 16)
            {
                File.WriteAllText(filePath, GenerateHexSecret(prefix, bytes) + Environment.NewLine, Encoding.UTF8);
                log.AppendLine("[OK] Generated cryptographic secret -> " + Path.GetFileName(filePath));
            }
            else
            {
                log.AppendLine("[OK] Existing secret preserved -> " + Path.GetFileName(filePath));
            }
        }

        public static string StartProductionStack(string repoRoot, string imageTag)
        {
            StringBuilder log = new StringBuilder();
            string tag = string.IsNullOrWhiteSpace(imageTag) ? "v1.0.0" : imageTag.Trim();
            log.AppendLine("=== Starting Docker Compose Production Stack (" + tag + ") ===");
            log.AppendLine(RunCommandCapture(repoRoot, "docker build -f infra/Dockerfile.api -t adas-crm-api:" + tag + " .", tag));
            log.AppendLine(RunCommandCapture(repoRoot, "docker compose -f infra/compose.prod.yml up -d postgres", tag));
            log.AppendLine(RunCommandCapture(repoRoot, "docker compose -f infra/compose.prod.yml run --rm --no-deps api node --conditions=production-dist apps/api/dist/cli/migrate.js", tag));
            log.AppendLine(RunCommandCapture(repoRoot, "docker compose -f infra/compose.prod.yml up -d api worker backup uptime-kuma", tag));

            string statePath = Path.Combine(repoRoot, ".deploy-state");
            if (File.Exists(statePath)) File.Copy(statePath, statePath + ".prev", true);
            File.WriteAllText(statePath, tag + Environment.NewLine, Encoding.UTF8);
            return log.ToString();
        }

        public static string RollbackStack(string repoRoot)
        {
            string prevPath = Path.Combine(repoRoot, ".deploy-state.prev");
            if (!File.Exists(prevPath))
            {
                return "[ERROR] No previous deployment tag recorded in .deploy-state.prev.";
            }
            string prevTag = File.ReadAllText(prevPath, Encoding.UTF8).Trim();
            if (string.IsNullOrWhiteSpace(prevTag))
            {
                return "[ERROR] .deploy-state.prev is empty.";
            }
            string output = RunCommandCapture(repoRoot, "docker compose -f infra/compose.prod.yml up -d --no-deps api worker backup", prevTag);
            File.WriteAllText(Path.Combine(repoRoot, ".deploy-state"), prevTag + Environment.NewLine, Encoding.UTF8);
            return "[OK] Rolled back services to " + prevTag + Environment.NewLine + output;
        }

        public static string UninstallStack(string repoRoot, bool purgeData, string confirmPhrase)
        {
            if (purgeData && confirmPhrase != PurgeConfirmationPhrase)
            {
                return "[ERROR] Refusing to purge volumes/backups without confirmation phrase \"" + PurgeConfirmationPhrase + "\".";
            }
            string cmd = purgeData
                ? "docker compose -f infra/compose.prod.yml --profile automation down --volumes"
                : "docker compose -f infra/compose.prod.yml --profile automation down";
            string output = RunCommandCapture(repoRoot, cmd, "v1.0.0");
            if (purgeData)
            {
                TryDeleteDirectory(Path.Combine(repoRoot, "data"));
                TryDeleteDirectory(Path.Combine(repoRoot, "secrets"));
                TryDeleteFile(Path.Combine(repoRoot, ".env.production"));
                TryDeleteFile(Path.Combine(repoRoot, ".deploy-state"));
                TryDeleteFile(Path.Combine(repoRoot, ".deploy-state.prev"));
                return "[OK] Containers stopped and data/secrets purged." + Environment.NewLine + output;
            }
            return "[OK] Containers stopped; PostgreSQL volumes, backups, and secrets preserved." + Environment.NewLine + output;
        }

        public static string CheckHealthEndpoint(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 5000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    return "[PASS] HTTP " + (int)resp.StatusCode + ": " + reader.ReadToEnd();
                }
            }
            catch (Exception ex)
            {
                return "[WARN] /healthz check failed: " + ex.Message;
            }
        }

        private static string RunShortCommand(string cwd, string command)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + command)
                {
                    WorkingDirectory = cwd,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (Process p = Process.Start(psi))
                {
                    string stdout = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(8000);
                    return p.ExitCode == 0 ? stdout.Trim() : "";
                }
            }
            catch
            {
                return "";
            }
        }

        private static string RunCommandCapture(string cwd, string command, string imageTag)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + command)
                {
                    WorkingDirectory = cwd,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                psi.EnvironmentVariables["ADAS_IMAGE_TAG"] = imageTag;
                using (Process p = Process.Start(psi))
                {
                    string stdout = p.StandardOutput.ReadToEnd();
                    string stderr = p.StandardError.ReadToEnd();
                    p.WaitForExit(300000);
                    StringBuilder sb = new StringBuilder();
                    if (!string.IsNullOrWhiteSpace(stdout)) sb.AppendLine(stdout.Trim());
                    if (!string.IsNullOrWhiteSpace(stderr)) sb.AppendLine(stderr.Trim());
                    return sb.ToString().Trim();
                }
            }
            catch (Exception ex)
            {
                return "[ERROR] " + ex.Message;
            }
        }

        private static void TryDeleteDirectory(string path)
        {
            try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
        }

        private static void TryDeleteFile(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }

    internal sealed class DeployerForm : Form
    {
        private readonly string _repoRoot;
        private readonly TextBox _domainBox;
        private readonly TextBox _tunnelNameBox;
        private readonly TextBox _tunnelTokenBox;
        private readonly TextBox _tagBox;
        private readonly TextBox _logBox;

        public DeployerForm(string repoRoot, string defaultDomain, string defaultTunnel)
        {
            _repoRoot = repoRoot;
            Text = "ADAS Globus Pro — Production Server Installer & Deployer (.exe)";
            Size = new Size(900, 660);
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
                Text = "ADAS CRM · Production Server Installer & Deployer",
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 13f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(20, 12)
            };
            Label subLabel = new Label
            {
                Text = "Preflight verification, idempotent 256-bit secrets, least-privilege PostgreSQL 17, health checks & safe rollback",
                ForeColor = Color.FromArgb(180, 210, 225),
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                AutoSize = true,
                Location = new Point(20, 38)
            };
            header.Controls.Add(titleLabel);
            header.Controls.Add(subLabel);

            Panel body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20) };

            Label domainLbl = new Label { Text = "Primary domain:", Location = new Point(20, 16), AutoSize = true };
            _domainBox = new TextBox { Text = defaultDomain, Location = new Point(165, 13), Width = 240 };

            Label tunnelLbl = new Label { Text = "Cloudflare Tunnel:", Location = new Point(425, 16), AutoSize = true };
            _tunnelNameBox = new TextBox { Text = defaultTunnel, Location = new Point(560, 13), Width = 280 };

            Label tokenLbl = new Label { Text = "CF Tunnel token:", Location = new Point(20, 50), AutoSize = true };
            _tunnelTokenBox = new TextBox { Text = "", Location = new Point(165, 47), Width = 420, UseSystemPasswordChar = true };

            Label tagLbl = new Label { Text = "Release tag:", Location = new Point(605, 50), AutoSize = true };
            _tagBox = new TextBox { Text = "v1.0.0", Location = new Point(695, 47), Width = 145 };

            Button btnPreflight = CreateButton("1. Preflight check", new Point(20, 88), 140, false);
            btnPreflight.Click += (s, e) => AppendLog(Program.RunPreflightReport(_repoRoot));

            Button btnProvision = CreateButton("2. Provision secrets & config", new Point(170, 88), 205, true);
            btnProvision.Click += (s, e) => AppendLog(Program.ProvisionAll(_repoRoot, _domainBox.Text, _tunnelNameBox.Text, _tunnelTokenBox.Text));

            Button btnStart = CreateButton("3. Build, migrate & start", new Point(385, 88), 185, true);
            btnStart.Click += (s, e) =>
            {
                AppendLog(Program.ProvisionAll(_repoRoot, _domainBox.Text, _tunnelNameBox.Text, _tunnelTokenBox.Text));
                AppendLog(Program.StartProductionStack(_repoRoot, _tagBox.Text));
            };

            Button btnHealth = CreateButton("4. Check /healthz", new Point(580, 88), 130, false);
            btnHealth.Click += (s, e) => AppendLog(Program.CheckHealthEndpoint("http://127.0.0.1:3000/healthz"));

            Button btnRollback = CreateButton("5. Rollback", new Point(720, 88), 120, false);
            btnRollback.Click += (s, e) => AppendLog(Program.RollbackStack(_repoRoot));

            _logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(20, 136),
                Size = new Size(820, 410),
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
            body.Controls.Add(tagLbl);
            body.Controls.Add(_tagBox);
            body.Controls.Add(btnPreflight);
            body.Controls.Add(btnProvision);
            body.Controls.Add(btnStart);
            body.Controls.Add(btnHealth);
            body.Controls.Add(btnRollback);
            body.Controls.Add(_logBox);

            Controls.Add(body);
            Controls.Add(header);

            AppendLog(Program.RunPreflightReport(_repoRoot));
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
