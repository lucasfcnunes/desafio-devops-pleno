# Kubernetes Multi-Node Security Challenge

This project provisions a multi-node k3s cluster on local virtual machines, installs Istio as the service mesh, and applies security policies for JWT authentication, mTLS, and traffic isolation between services.

## Overview

The environment contains 3 nodes:

- 1 server (`server-0`): k3s control plane
- 2 agents (`agent-0` and `agent-1`): workers

The application architecture contains 3 isolated namespaces:

- `service-1`: external entry point protected by JWT; routes to `service-2`
- `service-2`: internal service, reachable only through the `ServiceAccount` of `service-1`
- `service-3`: external entry point protected by JWT and isolated from `service-1` and `service-2`

Internal communication is protected by mTLS, and service identity depends on the Istio principal, represented as `cluster.local/ns/<namespace>/sa/<service-account>`.

---

## 1. Provisioning tool justification

I chose `Vagrant + libvirt` as the provisioning foundation.

### Reasons

- The challenge requires a real multi-node cluster, not a single-node setup.
- `libvirt` is native to Linux environments and offers strong compatibility with KVM/QEMU.
- `Vagrant` allows the environment to be reproduced declaratively with a single `Vagrantfile` and Ansible bootstrap.
- Provisioning is easily repeatable on a clean machine.
- The configuration in this repository already defines 3 VMs with a private network and a `k3s` setup using `--flannel-iface eth1` and `--node-external-ip` for each node.

### Main files

- `Vagrantfile`
- `ansible/playbooks/site.yaml`

---

## 2. Solution architecture

```mermaid
flowchart LR
  ext1[External client] -->|HTTPS + JWT| g1
  ext2[External client] -->|HTTPS + JWT| g3

  subgraph cluster[Kubernetes cluster]
    subgraph ingress_ns[namespace: istio-system]
      GW[istio-ingressgateway\nshared LoadBalancer Service]
        end

    subgraph mesh[Istio mesh]
      subgraph ns1[namespace: service-1]
        g1[Gateway\nservice-1.desafio-devops.local]
        s1[service-1]
      end

      subgraph ns2[namespace: service-2]
        s2[service-2]
      end

      subgraph ns3[namespace: service-3]
        g3[Gateway\nservice-3.desafio-devops.local]
        s3[service-3]
      end
        end
    end

  g1 -.->|selects shared ingress| GW
  g3 -.->|selects shared ingress| GW
  g1 -->|/service-1...\nshared istio-ingressgateway| s1
  s1 -->|/service-1/service-2\nmTLS\nSA: service-1| s2
  g1 -.->|/service-2\nblocked: 403| s2
  g3 -->|/service-3...\nshared istio-ingressgateway| s3

    s1 -. blocked .-> s3
    s2 -. blocked .-> s3
```

### External entry model

The requirement for `PeerAuthentication` in `STRICT` mode makes it impractical to expose each workload directly with a `LoadBalancer` service in each namespace, because external clients do not have the mesh mTLS identity and therefore cannot reach the pods directly.

For that reason, the solution uses:

- a single `istio-ingressgateway` workload/`Service` (`LoadBalancer`) in `istio-system`, shared by every external route
- two Istio `Gateway` resources, one defined in the `service-1` namespace and one in the `service-3` namespace, both selecting that same `istio-ingressgateway` workload (`selector: istio: ingressgateway`)
- `service-2` is intentionally reachable through the `service-1` `Gateway` at `/service-2` only to demonstrate that the direct route is rejected; there is no separate `Gateway` resource for `service-2`
- `VirtualService` to forward internal requests to workloads

This design preserves:

- controlled external access
- `JWT` validation right behind the shared entry point
- mandatory internal `mTLS`
- namespace isolation through `AuthorizationPolicy`

Note on where JWT is actually checked: the `Gateway` itself only terminates TLS and routes traffic; it does not evaluate JWTs. `RequestAuthentication` in `service-1` and `service-3` has no workload selector, so it applies to every workload in those namespaces and the check runs on the Envoy sidecar of the destination pod. `service-2` does not require or validate a JWT; its access control is based exclusively on the source mTLS principal.

The `service-1` `Gateway`/`VirtualService` pair is also what proves the `service-2` isolation requirement. The `VirtualService` on that `Gateway` defines two path-based routes: a request to `/service-2` is routed straight to the `service-2` workload, and a request to `/service-1/service-2` is routed to the `service-1` workload with the `/service-1` prefix stripped, so the `service-1` `wiremock` instance then proxies it onward to `service-2` using the principal `cluster.local/ns/service-1/sa/service-1`. Both requests reach `service-2`'s Envoy sidecar over mTLS, but only the second one is accepted:

- `GET /service-2` on the `service-1` `Gateway` — the request arrives at `service-2` carrying the `istio-ingressgateway` principal, which is not `service-1`, so `service-2`'s `AuthorizationPolicy` rejects it (`403`)
- `GET /service-1/service-2` on the `service-1` `Gateway` — the request first lands on `service-1`, which then calls `service-2` under `cluster.local/ns/service-1/sa/service-1`, so `service-2`'s `AuthorizationPolicy` allows it (`200`)

This is exactly why `service-2` is deliberately also reachable directly: not because there is no route to it, but so that a request bypassing `service-1`'s identity can be demonstrated and shown being rejected by identity-based `AuthorizationPolicy`, not by network unreachability.

There is no catch-all route on either `Gateway`. Each `VirtualService` only matches paths with the corresponding service prefix: `/service-1...`, `/service-2...`, or `/service-3...`. A path such as `/lucas` does not match any route and is not forwarded to any application service.

### Applied policies

- `PeerAuthentication` in `STRICT` mode in the `service-1`, `service-2`, and `service-3` namespaces
- no per-port or per-workload exceptions: each `PeerAuthentication` is the namespace-level `default` resource, with no `portLevelMtls` overrides and no workload selector, so `STRICT` mTLS covers every port and every workload in the three namespaces
- namespace label `istio-injection=enabled` to enable automatic sidecar injection
- `RequestAuthentication` in `service-1` and `service-3` using a public JWKS
- `AuthorizationPolicy`:
  - `service-1` requires a valid JWT
  - `service-2` accepts traffic only from the `ServiceAccount` of `service-1`
  - `service-3` accepts only requests coming from the ingress gateway and blocks `service-1` and `service-2`
- `DestinationRule` with `ISTIO_MUTUAL` for secure internal communication

---

## 3. Implementation details

### k3s cluster

The stack uses:

- k3s version: `v1.37.0+k3s1`
- base OS: Ubuntu 24.04 (`bento/ubuntu-24.04`)
- VM private network: `192.168.56.0/24`
- 3 nodes in `Ready` state

The cluster configuration is in:

- `Vagrantfile`
- `ansible/playbooks/site.yaml`

### Service mesh

The Istio installation is managed in:

- `k8s/istio/istio-operator.yaml`
- `k8s/helmfile.yaml.gotmpl`

The configuration uses the `default` profile, with `ingressGateways` enabled and no required egress gateway for the scope of this challenge.

### Services

The manifests and Helm values are in:

- `k8s/services/default-values.yaml.gotmpl`
- `k8s/services/service-1-values.yaml.gotmpl`
- `k8s/services/service-2-values.yaml.gotmpl`
- `k8s/services/service-3-values.yaml.gotmpl`

The artifacts include:

- `PeerAuthentication`
- `RequestAuthentication`
- `AuthorizationPolicy`
- `Gateway`
- `VirtualService`
- `DestinationRule`
- `ScaledObject` (bonus)

### Deployment method per service

As required by the challenge, each service uses a different deployment method:

- `service-1`: rendered once from the shared Helm templates and committed as a static YAML manifest at `k8s/services/raw-manifests/svc-1.yaml`, then applied with plain `kubectl apply` (`task kapply:svc-1.yaml`) — no `helm install`/`helmfile apply` is used for this service at deploy time.
- `service-2`: installed as a regular Helm release through `helmfile` (`stakater/application` chart).
- `service-3`: installed as a Helm release using the same chart family as `service-2`. The challenge allows either YAML or Helm for this service; the same `helmfile template` + `kubectl apply` flow used for `service-1` could be applied here if a plain-YAML deployment is preferred.

---

## 4. JWT and JWKS configuration

The project generates an EC P-256 key and publishes the public portion in `fake-vault/jwt/jwks.json`.

### Keys

- `fake-vault/jwt/private.dec.jwk`
- `fake-vault/jwt/public.jwk`
- `fake-vault/jwt/jwks.json`

### Algorithm and identity

- JWT algorithm: `ES256`
- curve: `P-256`
- issuer: `https://desafio-devops.local`
- `aud`: `service-1`, `service-2`, `service-3`
- `kid`: `desafio-devops-es256-1`

The `RequestAuthentication` configuration uses the public key in `jwks.json` to validate the JWT signature in Istio.

### Generating the token

The repository already contains a generation flow through `Taskfile`:

```bash
# generate key and JWKS
 task jwk:setup

# generate a valid token
 task jwt:gen

# verify token validation with the JWKS
 task jwt:test
```

Example of manual generation:

```bash
step crypto jwt sign \
  --key ./fake-vault/jwt/private.dec.jwk \
  --alg ES256 \
  --kid desafio-devops-es256-1 \
  --iss https://desafio-devops.local \
  --sub demo-user \
  --aud service-1 \
  --aud service-3 \
  --exp "$(date -u -d '+1 days' +%s)"
```

---

## 5. Reproducible step-by-step guide from scratch

### Operating system and environment

This project is designed to run on native Linux. Several components depend on Linux features, including KVM, libvirt, private networking, and the k3s virtual machines.

### My host setup

My primary machine is Windows because I use Windows-only data tools such as Power BI and Excel. Linux runs in a NixOS VM (a declarative Linux distribution) on Hyper-V, and I develop over SSH using VS Code Remote-SSH.

I also use WSL for Linux workflows, but it is not recommended for this project when using the libvirt provider. Running libvirt VMs from WSL requires a custom kernel and additional virtualization integration, which is outside the supported setup. The libvirt-based cluster should run on the NixOS VM or another native Linux environment instead.

To make my nested libvirt VMs work reliably under Hyper-V, I had to enable nested virtualization and MAC address spoofing on the virtual switch used by my NixOS guest. My NixOS configuration also needed two changes, kept here for reference:

- [feat: add libvirt config · lucasfcnunes/dotfiles@62e7230](https://github.com/lucasfcnunes/dotfiles/commit/62e72309f1e5ff2e2d516882e6c01ed68a07f896) — enables `libvirtd`, allows bridge-to-bridge traffic (`virbr*`/`vnet*`), enables IP forwarding, and disables strict reverse-path filtering so inter-VM networking works.
- [chore: make nixos more flexible on /etc/hosts editing for dev · lucasfcnunes/dotfiles@4968406](https://github.com/lucasfcnunes/dotfiles/commit/4968406f0c565d89ca17ef57f31cca49811256df) — NixOS normally manages `/etc/hosts` as a read-only symlink, which breaks `hostctl`; this makes `/etc/hosts` writable and syncs it from the Nix-managed original on boot.

This setup is specific to my machine and is not required to reproduce the challenge — any native Linux host (bare metal or a VM with nested virtualization enabled) works.

### Recommended development environment

VS Code is recommended because it provides an integrated terminal, editor support for YAML and Nix, and a convenient workflow for running project tasks. Everything can also be run from a regular terminal; the terminal-only workflow has the same capabilities with less development convenience.

### Installing devenv

`devenv` provides the project toolchain declared in `devenv.nix`, including Ansible, Vagrant, libvirt, QEMU/KVM, kubectl, Helm, Helmfile, k6, `step`, SOPS, Task, and supporting utilities.

`devenv` also works on other Linux distributions; NixOS is simply the Linux environment I use. The host still needs working KVM/libvirt support for the Vagrant VMs.

Install Nix with flakes enabled:

```bash
curl -L https://nixos.org/nix/install | sh -s -- --daemon
```

Restart the terminal or load the Nix profile, then install `devenv`:

```bash
curl -L https://devenv.sh/install.sh | bash
```

From the repository root, allow the project and enter the development environment:

```bash
devenv allow
devenv shell
```

The project also provides a Taskfile shortcut:

```bash
task devenv:setup
```

When using `direnv`, the environment can be loaded automatically after installing `direnv` and running:

```bash
direnv allow
```

The `devenv.nix` file is the source of truth for the development environment. Do not install every project dependency globally when using `devenv`; enter the shell first and run commands from there.

Official references:

- [Nix installation guide](https://nixos.org/download/)
- [devenv installation](https://devenv.sh/getting-started/)
- [devenv basics and shells](https://devenv.sh/basics/)

### Native Linux prerequisites

On the development host, install:

```bash
sudo apt-get update
sudo apt-get install -y libvirt-daemon-system libvirt-clients qemu-kvm
```

Enable the libvirt service and make sure the current user can access virtualization resources:

```bash
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt,kvm "$USER"
```

Log out and back in after changing group membership. If you use the repository's `devenv` environment, the remaining tools are provided automatically.

Once you enter the `devenv` shell, the project utilities are available automatically. This includes Vagrant, Helm, kubectl, Helmfile, Ansible, k6, `step`, SOPS, Task, `yq`, `dyff`, and the other tools declared in `devenv.nix`.

Host and workflow references:

- [Ubuntu libvirt documentation](https://documentation.ubuntu.com/server/how-to/virtualisation/libvirt/)
- [Vagrant libvirt provider](https://vagrant-libvirt.github.io/vagrant-libvirt/)
- [Vagrant Ansible provisioner](https://developer.hashicorp.com/vagrant/docs/provisioning/ansible)
- [Microsoft: nested virtualization](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/nested-virtualization)

### 1) Clone the repository

```bash
git clone https://github.com/lucasfcnunes/desafio-devops-pleno.git
cd desafio-devops-pleno
```

### 2) Prepare Ansible dependencies

```bash
task ansible:requirements-setup
```

### 3) Start the infrastructure

```bash
task vagrant:up
```

This provisions:

- `server-0`
- `agent-0`
- `agent-1`

### 4) Copy the kubeconfig

```bash
task kubeconfig:cp
```

### 5) Verify the cluster

```bash
kubectl get nodes
kubectl get pods -A
```

All nodes must be in `Ready` state.

### 6) Install the Istio stack and dependencies

```bash
task helmfile:sync
```

### 7) Install the `service-1` manifest

```bash
task kapply:svc-1.yaml
```

### 8) Validate the services

```bash
task test
```

---

## 6. Requirement validation

### 6.1 Functional k3s cluster

```bash
kubectl get nodes
kubectl get nodes -o wide
```

Expected result: 3 nodes in `Ready` state.

### 6.2 `PeerAuthentication` in `STRICT` mode

```bash
kubectl get peerauthentication -A
kubectl describe peerauthentication default -n service-1
kubectl describe peerauthentication default -n service-2
kubectl describe peerauthentication default -n service-3
```

Expected result:

- `spec.mtls.mode: STRICT`
- applied to all application namespaces

### 6.3 JWT: no token, invalid token, and valid token

For `service-1`:

```bash
curl -i https://service-1.desafio-devops.local/service-1 \
  --cacert ./fake-vault/tls/rootCA.pem.crt

curl -i https://service-1.desafio-devops.local/service-1 \
  -H "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0." \
  --cacert ./fake-vault/tls/rootCA.pem.crt

curl -i https://service-1.desafio-devops.local/service-1 \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Expected results:

- no token → `403` (Istio's `AuthorizationPolicy` denies the request because `request.auth.principal` is empty; the JWT filter does not reject a missing token by itself)
- invalid token → `401` (the JWT filter itself rejects the request because the signature/issuer cannot be validated)
- valid token → `200`

> The challenge description lists `401` for the missing-token case. In practice, Istio's `RequestAuthentication` treats a missing token as anonymous rather than invalid, so the rejection happens one layer later, at the `AuthorizationPolicy`, and results in `403`. This is the actual behavior you will observe when running the commands above, and is called out here so the validation results are not mistaken for a misconfiguration.

Repeat for `service-3`:

```bash
curl -i https://service-3.desafio-devops.local/service-3 \
  --cacert ./fake-vault/tls/rootCA.pem.crt

curl -i https://service-3.desafio-devops.local/service-3 \
  -H "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0." \
  --cacert ./fake-vault/tls/rootCA.pem.crt

curl -i https://service-3.desafio-devops.local/service-3 \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

The expected results are the same as for `service-1`: no token returns `403`, an invalid token returns `401`, and a valid token returns `200`. For the complete automated matrix, including forbidden and wrong-audience tokens on all gateway paths, run `task k6:test` as described in [section 7](#7-automated-validation-tasks).

### 6.4 Blocking direct access to `service-2`

The `AuthorizationPolicy` for `service-2` accepts traffic only when the mTLS source principal is `cluster.local/ns/service-1/sa/service-1`. `service-2` does not require or validate a JWT.

```bash
kubectl describe authorizationpolicy service-2-only-from-service-1 -n service-2
```

Practical validation from inside the cluster:

```bash
kubectl run netshoot --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'curl -I http://service-2.service-2.svc.cluster.local'
```

Expected result: access denied.

The same rejection can be shown through the `service-1` `Gateway` itself, without going through the internal `service-1` route: the `VirtualService` routes `/service-2` straight to the `service-2` workload, which then sees the `istio-ingressgateway` principal instead of `service-1`'s and denies the request.

```bash
curl -i https://service-1.desafio-devops.local/service-2 \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Expected result: `403`, even with a valid JWT, because the request never goes through `service-1`'s own workload identity.

Paths without a service prefix are not routed either:

```bash
curl -i https://service-1.desafio-devops.local/lucas \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Expected result: no application route is selected; `/lucas` is not forwarded to `service-1`, `service-2`, or `service-3`.

### 6.5 Isolation of `service-3`

```bash
kubectl run netshoot --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'curl -I http://service-3.service-3.svc.cluster.local'
```

Or, from a pod in `service-1` or `service-2`, attempt to access `service-3`.

Expected result: blocked by `AuthorizationPolicy`.

### 6.6 Internal routing from `service-1` to `service-2`

```bash
curl -i https://service-1.desafio-devops.local/service-1/service-2 \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Expected result: `200`. Unlike the `/service-2` path used in [6.4](#64-blocking-direct-access-to-service-2), the `/service-1/service-2` path is routed by the `VirtualService` to the `service-1` workload first (with the `/service-1` prefix stripped); `service-1`'s `wiremock` instance then calls `service-2` on its own, using its own `ServiceAccount` identity, which is what `service-2`'s `AuthorizationPolicy` allows.

---

## 7. Automated validation tasks

The repository also provides Taskfile commands that exercise the scenarios from inside the cluster and through the external gateways:

### mTLS and authorization validation

```bash
task mtls:test
```

This enables the `miscellaneous` Helmfile release and creates two Kubernetes Jobs in the `miscellaneous` namespace:

- `curl-job-with-sidecar`: runs requests with an injected Istio sidecar
- `curl-job-without-sidecar`: runs requests without an Istio sidecar

The Jobs attempt to call `service-1`, `service-2`, and `service-3`. This demonstrates the difference between traffic carrying a mesh identity and traffic from a pod without a sidecar, including the direct access rejection enforced by `service-2`'s `AuthorizationPolicy`.

Inspect the generated Jobs and logs with:

```bash
kubectl get jobs,pods -n miscellaneous
kubectl logs -n miscellaneous job/curl-job-with-sidecar
kubectl logs -n miscellaneous job/curl-job-without-sidecar
```

### JWT matrix validation

```bash
task k6:test
```

This runs `k6/test.js` as a short validation and checks the JWT matrix across the gateway routes, including valid, invalid, missing, and wrong-audience tokens. `service-1` and `service-3` return `401` for invalid JWTs, while `service-2` returns `403` because it does not validate JWTs and only accepts the `service-1` mTLS principal. Valid and denied routes are checked with the corresponding `200` and `403` expectations.

```console
  (...)
  █ TOTAL RESULTS 

    checks_total.......: 36      17.947806/s
    checks_succeeded...: 100.00% 36 out of 36
    checks_failed......: 0.00%   0 out of 36

    ✓ JWT(exists=N valid=x aud=x); GW=1->SVC=1 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=1->SVC=1 path=                       ; -> expected=401; actual=401;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=1->SVC=1 path=                       ; -> expected=200; actual=200;
    ✓ JWT(exists=Y valid=Y aud=N); GW=1->SVC=1 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=1->SVC=1 path=/service-2             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=1->SVC=1 path=/service-2             ; -> expected=401; actual=401;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=1->SVC=1 path=/service-2             ; -> expected=200; actual=200;
    ✓ JWT(exists=Y valid=Y aud=N); GW=1->SVC=1 path=/service-2             ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=1->SVC=1 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=1->SVC=1 path=/service-3             ; -> expected=401; actual=401;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=1->SVC=1 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=N); GW=1->SVC=1 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=1->SVC=2 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=1->SVC=2 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=1->SVC=2 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=N); GW=1->SVC=2 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=1->SVC=2 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=1->SVC=2 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=1->SVC=2 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=N); GW=1->SVC=2 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=1->SVC=2 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=1->SVC=2 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=1->SVC=2 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=N); GW=1->SVC=2 path=/service-3             ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=3->SVC=3 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=3->SVC=3 path=                       ; -> expected=401; actual=401;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=3->SVC=3 path=                       ; -> expected=200; actual=200;
    ✓ JWT(exists=Y valid=Y aud=N); GW=3->SVC=3 path=                       ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=3->SVC=3 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=3->SVC=3 path=/service-1             ; -> expected=401; actual=401;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=3->SVC=3 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=N); GW=3->SVC=3 path=/service-1             ; -> expected=403; actual=403;
    ✓ JWT(exists=N valid=x aud=x); GW=3->SVC=3 path=/service-2             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=N aud=x); GW=3->SVC=3 path=/service-2             ; -> expected=401; actual=401;
    ✓ JWT(exists=Y valid=Y aud=Y); GW=3->SVC=3 path=/service-2             ; -> expected=403; actual=403;
    ✓ JWT(exists=Y valid=Y aud=N); GW=3->SVC=3 path=/service-2             ; -> expected=403; actual=403;
  (...)
```

### KEDA stress test

```bash
task k6:stress
```

This runs the longer k6 workload defined in `k6/test.js` and generates traffic against the JWT-protected routes so the Istio request metric can trigger the KEDA `ScaledObject`.

Observe scale-up and scale-down in another terminal:

```bash
kubectl get scaledobjects -A
kubectl get hpa -A
kubectl get pods -n service-1 -w
```

The complete sequence is also available through:

```bash
task test
```

It runs `mtls:test`, `jwt:test`, `k6:test`, and `k6:stress`.

---

## 8. Rationale behind non-trivial decisions

### `libvirt` instead of `VirtualBox`

- better fit for Linux environments using KVM/QEMU
- lower friction on Linux-based development hosts
- more stable and reproducible execution

### k3s version

- `v1.37.0+k3s1` was chosen to keep a recent version compatible with the modern Kubernetes ecosystem

### Base image: Ubuntu 24.04

The current configuration uses `bento/ubuntu-24.04`. I also tested `bento/ubuntu-26.04` because it is newer, recently supported as an LTS release, and can reduce the number of known CVEs over time. However, that image exposed compatibility problems in this specific provisioning chain, including Vagrant SSH key creation and Ansible provisioning. Ubuntu 24.04 was kept because the Vagrant SSH bootstrap and Ansible provisioning completed reliably with it.

This is a reproducibility decision rather than a claim that Ubuntu 24.04 is inherently more secure than Ubuntu 26.04. The base image can be revisited when the Vagrant/Bento SSH workflow and the Ansible dependencies provide stable support for Ubuntu 26.04.

### CNI and Istio

- `k3s` uses Flannel by default
- Istio is installed with the standard sidecar stack and does not require CNI replacement
- this keeps the solution simple and reproducible without extra networking dependencies

### `PeerAuthentication` in `STRICT` mode

- it is the safest mode required by the challenge
- it intentionally removes direct external access to workloads
- the solution uses the Istio `Gateway` as the edge and `VirtualService` for internal routing

### `ES256` instead of `RS256`

- the repository already generates and validates an EC JWK
- it is a modern and lightweight JWT standard for lab environments
- it keeps the example simple and compatible with Istio `RequestAuthentication`

### Explicit `ServiceAccount` usage

- without a named `ServiceAccount`, Istio may fall back to `default`
- this would make the identity policy for `service-2` ambiguous and break validation using `source.principals`

### `PeerAuthentication` scope: per namespace, not mesh-wide

- each application namespace (`service-1`, `service-2`, `service-3`) gets its own namespace-level `default` `PeerAuthentication`, instead of a single mesh-wide policy in `istio-system`
- this keeps the `STRICT` requirement scoped exactly to the challenge's application namespaces, without forcing strict mTLS onto unrelated namespaces (for example `kube-system` or `monitoring`) that may contain workloads without sidecars

### Static private VM network addressing

- the challenge does not require manual IP, `/etc/hosts`, or firewall configuration, and none of that was done by hand for node-to-node communication
- `k3s` agents still need to know the server's address before the server exists, so `Vagrant` assigns static addresses on the private network (`192.168.56.0/24`); the network itself continues to be created and managed by `Vagrant`/`libvirt`, only the address layout is fixed so it can be passed into the Ansible provisioning as a known `api_endpoint`

### Application image (`wiremock`)

- `wiremock/wiremock` was chosen as the HTTP application for all three services
- it requires no custom application code and exposes a JSON echo response out of the box, useful for inspecting headers and JWT claims while testing
- its response templating engine is used to proxy `service-1` requests to `service-2` (`k8s/services/wiremock/mappings.yaml`), which is exactly the cross-namespace call the challenge asks for

---

## 9. Bonus — autoscaling with KEDA + Prometheus

The repository already includes support for observing Istio metrics and scaling services with KEDA.

### Chosen metric

The reference metric used in the `ScaledObject` is:

```text
sum(rate(istio_requests_total{reporter="destination", destination_workload_namespace="<namespace>", destination_workload="<service>"}[1m]))
```

This measures the request throughput per minute for each workload. Under load, KEDA increases the number of replicas; when the load is removed, it scales down again.

### Installation

The Prometheus and KEDA installation flow is already included in:

- `k8s/helmfile.yaml.gotmpl`
- `k8s/kube-prometheus-stack/values.yaml.gotmpl`
- `k8s/keda/values.yaml.gotmpl`

### k6 script

The load-generation script is in:

- `k6/test.js`

It generates JWT tokens and sends a high volume of requests to the endpoints exposed by `service-1` and `service-3`.

### Execution

```bash
cd ./k6
k6 run ./test.js
```

Expected behavior:

- increase in `ScaledObject` replicas
- stabilization under high load
- reduction in replicas after load is removed

```bash
kubectl get hpa -A
kubectl get pods -n service-1 -w
```

---

## 10. Repository structure

```text
.
├── Vagrantfile
├── Taskfile.yaml
├── README.md
├── README.pt-BR.md
├── INSTRUCTIONS.md
├── ansible/
│   ├── requirements.yaml
│   └── k3s-ansible/
├── fake-vault/
│   ├── jwt/
│   └── tls/
├── k8s/
│   ├── helmfile.yaml.gotmpl
│   ├── istio/
│   ├── keda/
│   ├── kube-prometheus-stack/
│   └── services/
├── k6/
│   ├── jwt-utils.js
│   └── test.js
└── ...
```

---

## 11. Final notes

This challenge was implemented with a focus on:

- reproducibility
- security by default
- real service mesh and mTLS usage
- JWT-based ingress authentication
- clear separation of responsibilities between ingress, workloads, and access policies

The implementation aligns with the stated requirements and reflects the recommended design for a Kubernetes cluster with Istio in strict mode, while keeping the scenario realistic, testable, and easy to reproduce.
