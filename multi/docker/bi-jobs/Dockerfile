# bi-jobs with an SSH server added, so `wrangler containers ssh <instance-id>` has something to connect to.
# The vendor image is Ubuntu 24.04 and runs as root. Nothing else about it is changed.
FROM docker.io/syncfusion/boldbi-server-jobs:17.1.30

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && printf '%s\n' \
         'Port 22' \
         'PermitRootLogin prohibit-password' \
         'PasswordAuthentication no' \
         'KbdInteractiveAuthentication no' \
         'PubkeyAuthentication yes' \
         'AuthorizedKeysFile .ssh/authorized_keys /etc/ssh/authorized_keys/%u' \
         > /etc/ssh/sshd_config.d/10-cloudflare.conf
