---
title: Hosting on AWS, GCP, and Azure
summary: Run mybase on one cloud VM (EC2, Compute Engine, Azure VM): sizing, firewall, Cloudflare Tunnel or Tailscale, disks, snapshots.
section: Reference
order: 33
---

# Hosting on AWS, GCP, and Azure

mybase runs the same on a cloud VM as on a Raspberry Pi: one Linux machine with Docker, the compose stack from [Self-hosting](self-hosting.md), and `mybase server setup`. Every provider below follows the same shape:

1. Create **one VM** (arm64 or amd64, Ubuntu 24.04) with an SSD disk.
2. Allow only SSH in the cloud firewall (or nothing, with the provider's SSH proxy).
3. Install Docker, then run the setup wizard.
4. Reach it through a **Cloudflare Tunnel** (public) or **Tailscale** (private).
5. Schedule disk snapshots.

## What not to use

- **Managed containers** (ECS/Fargate, Cloud Run, Azure Container Apps, App Service): mybase needs persistent volumes, exactly one API instance (cron, queue long polls, realtime, and hosting state live in its memory), and, for hosting and sandboxes, the Docker socket.
- **Managed Postgres** (RDS, Cloud SQL, Azure Database for PostgreSQL): the API needs a real superuser (creating roles and databases, `CREATE EXTENSION`, writing `pg_hba.conf` and certificates into PGDATA), plus the extensions and preloads in `mybase-postgres`. Use the bundled Postgres container.
- **Managed object storage** (S3, GCS, Blob) in place of Garage: buckets and keys are provisioned through Garage's admin API.
- **A cloud load balancer or your own reverse proxy in front of :4000 without telling mybase**: set `MYBASE_TRUST_PROXY` to the proxy's addresses (e.g. `10.0.0.0/16` for a load balancer's subnet, `127.0.0.1,172.16.0.0/12` for nginx on the VM) and make the proxy overwrite `X-Forwarded-For` and `X-Forwarded-Proto`. Without it every visitor looks like the proxy's IP, so login throttling locks everyone out together and session cookies miss `Secure`. The tunnel is still simpler.
- **Several VMs or autoscaling**: one machine per mybase install.

## Sizing

| | Minimum | Recommended | With hosting / sandboxes |
| --- | --- | --- | --- |
| vCPU | 2 | 2 | 4+ |
| RAM | 2 GB (add swap) | 4 GB | 8 GB+ (each running sandbox gets 1 GB; each site 512 MB by default) |
| Disk | 30 GB SSD | 50 GB SSD | 100 GB+ (site images, registry) |

arm64 instances (AWS Graviton, GCP Tau T2A / Axion, Azure Ampere) are usually the cheapest per GB of RAM, and all mybase images are multi-arch. Burstable types (t4g, e2, B-series) are fine: mybase is idle most of the time.

| | arm64 | amd64 |
| --- | --- | --- |
| AWS | `t4g.medium` (2 vCPU, 4 GB) | `t3.medium` |
| GCP | `t2a-standard-1` (1 vCPU, 4 GB) or `t2a-standard-2` | `e2-medium` (2 shared vCPU, 4 GB) |
| Azure | `Standard_B2pls_v2` (2 vCPU, 4 GB) | `Standard_B2s` (2 vCPU, 4 GB) |

## Firewall

Compose publishes 4000, 5432, 3900, 6379 (and 80 with hosting) on every interface, and Docker's published ports skip host firewalls like `ufw`. **The cloud firewall (security group, VPC firewall rule, NSG) is the real fence.** Open only:

| Port | When |
| --- | --- |
| 22 | SSH, from your own IP only. Not needed with AWS Session Manager, GCP IAP, or Azure Bastion |
| 5432 | Only for [public Postgres](database.md) (`mybase server database-public`) |

Nothing else. The Cloudflare Tunnel and Tailscale only make outbound connections. When the wizard asks to close the Postgres, S3, and cache ports, say yes (`POSTGRES_BIND`, `GARAGE_S3_BIND`, `VALKEY_BIND` = `127.0.0.1`) unless apps reach them over Tailscale.

## AWS (EC2)

```sh
# Security group: SSH from your IP only.
aws ec2 create-security-group --group-name mybase --description "mybase"
aws ec2 authorize-security-group-ingress --group-name mybase --protocol tcp --port 22 --cidr "$(curl -s https://checkip.amazonaws.com)/32"

# Ubuntu 24.04 arm64 on a 4 GB Graviton, 50 GB gp3.
aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
  --instance-type t4g.medium \
  --key-name <your-key-pair> \
  --security-groups mybase \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":50,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=mybase}]'

ssh ubuntu@<public-ip>
```

For amd64, use `t3.medium` and `.../24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`.

- **Public IP:** it changes on stop/start. That's fine with the tunnel; for public Postgres either attach an Elastic IP or rely on mybase's DNS updater (it re-points `db.<domain>` every 5 minutes).
- **Snapshots:** EC2 → Lifecycle Manager → create a policy for the instance's volume (daily, keep 7–14), or add the instance to AWS Backup.
- **No SSH port:** attach an instance profile with `AmazonSSMManagedInstanceCore`, drop the port 22 rule, and connect with `aws ssm start-session --target <instance-id>`.

## Google Cloud (Compute Engine)

```sh
gcloud compute instances create mybase \
  --zone=us-central1-a \
  --machine-type=t2a-standard-1 \
  --image-family=ubuntu-2404-lts-arm64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB --boot-disk-type=pd-balanced

gcloud compute ssh mybase --zone=us-central1-a
```

For amd64, use `--machine-type=e2-medium --image-family=ubuntu-2404-lts-amd64`. T2A is only in some regions (`gcloud compute machine-types list --filter="name=t2a-standard-1"`).

- **Firewall:** the default network's `default-allow-ssh` rule allows SSH from anywhere. Restrict it to IAP's range and connect with `--tunnel-through-iap`:
  ```sh
  gcloud compute firewall-rules update default-allow-ssh --source-ranges=35.235.240.0/20
  gcloud compute ssh mybase --zone=us-central1-a --tunnel-through-iap
  ```
  Also check that `default-allow-http`/`https` aren't on, and that nothing opens 4000/5432/3900/6379.
- **Public IP:** ephemeral by default; reserve a static one only for public Postgres if you want it fixed.
- **Snapshots:**
  ```sh
  gcloud compute resource-policies create snapshot-schedule mybase-daily \
    --region=us-central1 --max-retention-days=14 --daily-schedule --start-time=04:00
  gcloud compute disks add-resource-policies mybase --zone=us-central1-a --resource-policies=mybase-daily
  ```

## Azure (Virtual Machines)

```sh
az group create -n mybase -l eastus

az vm create -g mybase -n mybase \
  --image Canonical:ubuntu-24_04-lts:server-arm64:latest \
  --size Standard_B2pls_v2 \
  --admin-username azureuser --generate-ssh-keys \
  --os-disk-size-gb 64 --storage-sku StandardSSD_LRS

# az vm create opens SSH to the world: limit it to your IP.
az network nsg rule update -g mybase --nsg-name mybaseNSG -n default-allow-ssh \
  --source-address-prefixes "$(curl -s https://checkip.amazonaws.com)/32"

ssh azureuser@<public-ip>
```

For amd64, use `--image Ubuntu2404 --size Standard_B2s`.

- **No SSH port:** use Azure Bastion and delete the `default-allow-ssh` rule.
- **Snapshots:** enable Azure Backup for the VM:
  ```sh
  az backup vault create -g mybase -n mybase-vault -l eastus
  az backup protection enable-for-vm -g mybase --vault-name mybase-vault --vm mybase --policy-name DefaultPolicy
  ```

## Install mybase on the VM

Same on every provider, over SSH:

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
exit   # log out and back in so the docker group applies

curl -fsSL https://usemybase.dev/install.sh | sh -s -- --setup
```

In the wizard:

- **Who should reach mybase?** Pick *the internet, through a Cloudflare Tunnel* for public HTTPS on your domain, and/or *devices on my network or Tailscale* for private access (see below). Don't expose :4000 directly: it's plain HTTP.
- **Close the Postgres, S3, and cache ports?** Yes, unless apps use them over Tailscale.
- **Start on boot:** yes.
- **Admin account:** created here, from the VM itself, so the setup page is never open to the internet.

Then harden `.env` (`~/mybase/.env`) and run `mybase server update` to apply it:

```sh
MYBASE_OUTBOUND=public        # cron jobs and webhooks may only call the public internet
MYBASE_BIND=127.0.0.1         # :4000 only for the tunnel and SSH port forwards
POSTGRES_BIND=127.0.0.1       # unless you use public Postgres or Tailscale
GARAGE_S3_BIND=127.0.0.1
VALKEY_BIND=127.0.0.1
```

Then sign in at `https://mybase.<domain>`, or without a tunnel through SSH: `ssh -L 4000:localhost:4000 <vm>` and open http://localhost:4000. Turn on [two-factor sign-in](self-hosting.md) before using it publicly.

Scripted (cloud-init, Terraform, CI): `mybase server setup --yes --tunnel-token <token> --domain <domain> --admin-password-stdin < password-file`. See [Self-hosting](self-hosting.md) for every flag.

### Tailscale instead of a tunnel

For private-only access (your apps and laptop on the same tailnet):

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then in the wizard pick *devices on my network or Tailscale* and use the VM's MagicDNS name (`mybase.<tailnet>.ts.net`) as the host. Apps on the tailnet connect to Postgres (:5432), S3 (:3900), and the cache (:6379) directly; keep those ports closed in the cloud firewall, since Tailscale traffic doesn't pass through it. You can combine Tailscale with a tunnel.

## Optional services on a VM

- **Security:** follow [Security best practices](security-best-practices.md), and run `mybase doctor` until it shows no `critical` or `warn` findings.
- **Hosting:** sites are plain containers on the VM (not gVisor): deploy only code you trust, and put them on a different domain from the dashboard. `mybase server hosting --domain <domain>` works the same; sites go out through the tunnel. Size the VM for the sites you run.
- **Sandboxes:** `mybase server sandbox` installs gVisor. Ubuntu 24.04 cloud images have cgroup v2, and gVisor doesn't need nested virtualization.
- **Public Postgres:** open TCP 5432 in the cloud firewall (from anywhere, or only your apps' IPs), then `mybase server database-public`. No router step: the VM's public IP is detected automatically.
- **Web search:** engines throttle datacenter IPs harder than home connections, so expect more suspended engines than on a home server.

## Backups

On a cloud VM, use both:

- **Disk snapshots** (above): they capture Postgres, Garage, Valkey, and `.env` together. Postgres recovers from a crash-consistent snapshot like from a power cut.
- **A copy of `MYBASE_SECRETS_KEY` off the VM** (password manager, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault). Snapshots of a deleted or broken disk don't help if this is the only copy; without it, stored secrets are gone.

For an extra logical copy, run `mybase server backup --encrypt` and upload the `.mbk` file to the provider's object storage. It also moves the instance to another VM or CPU type (`mybase server restore`). See [Self-hosting](self-hosting.md).

## Costs to watch

- **Egress:** clouds bill outbound traffic, including traffic through the Cloudflare Tunnel. Large public files or busy sites cost more than the VM.
- **Public IPv4:** AWS bills every public IPv4 address hourly. With the tunnel or Tailscale and SSM, the VM doesn't need one, but it then needs a NAT gateway (more expensive) or an IPv6 egress path to reach the internet; usually simplest to keep the public IP with no inbound rules.
- **Snapshots and backup vaults** are billed by stored size.

## Agent notes

- One VM per install, with the bundled Postgres, Garage, and Valkey containers. No managed databases, object storage, container services, load balancers, or autoscaling.
- Public access goes through the Cloudflare Tunnel (`MYBASE_TRUST_PROXY=cloudflare`); any other proxy in front of :4000 breaks client IPs, login throttling, first-run protection, and Secure cookies.
- Docker's published ports bypass `ufw`: secure the cloud firewall, and open only 22 (or nothing) plus 5432 for public Postgres.
- Install with `mybase server setup` over SSH; non-interactive with `--yes --json`.
- Back up with scheduled disk snapshots, and keep `MYBASE_SECRETS_KEY` outside the VM.
