# Desafio Técnico — Pessoa Engenheira DevOps

Este projeto provisiona um cluster k3s multi-nó em máquinas virtuais locais, instala o Istio como service mesh e aplica políticas de segurança para autenticação JWT, mTLS e isolamento de tráfego entre serviços.

## Visão geral

O ambiente foi montado com 3 nós:

- 1 servidor (`server-0`): control plane do k3s
- 2 agentes (`agent-0` e `agent-1`): workers

A arquitetura da aplicação conta com 3 namespaces isolados:

- `service-1`: entrada externa protegida por JWT; roteia para `service-2`
- `service-2`: serviço interno, acessível apenas pela `ServiceAccount` de `service-1`
- `service-3`: entrada externa protegida por JWT e isolada contra `service-1` e `service-2`

A comunicação interna é protegida por mTLS, e a identidade de serviço depende do principal do Istio, representado por `cluster.local/ns/<namespace>/sa/<service-account>`.

---

## 1. Justificativa da ferramenta de provisionamento

Escolhi `Vagrant + libvirt` como base de provisionamento.

### Motivos

- O requisito do desafio exige um cluster multi-nó real, não single-node.
- `libvirt` é nativo em ambientes Linux e oferece boa compatibilidade com KVM/QEMU.
- `Vagrant` permite reproduzir o ambiente de forma declarativa com um único `Vagrantfile` e um bootstrap via Ansible.
- O provisionamento é facilmente reexecutável em uma máquina limpa.
- A configuração usada no repositório já define 3 VMs com rede privada e um `k3s` configurado com `--flannel-iface eth1` e `--node-external-ip` para cada nó.

### Arquivos principais

- `Vagrantfile`
- `ansible/playbooks/site.yaml`

---

## 2. Arquitetura da solução

```mermaid
flowchart LR
    ext1[Cliente externo] -->|HTTPS + JWT| GW[Istio Ingress Gateway\nLoadBalancer em istio-system]
    ext2[Cliente externo] -->|HTTPS + JWT| GW

    subgraph mesh[Istio mesh]
        subgraph ns1[namespace: service-1]
            s1[service-1]
        end

        subgraph ns2[namespace: service-2]
            s2[service-2]
        end

        subgraph ns3[namespace: service-3]
            s3[service-3]
        end
    end

    GW -->|JWT validate| s1
    s1 -->|mTLS| s2
    GW -->|JWT validate| s3

    s1 -. bloqueado .-> s3
    s2 -. bloqueado .-> s3
```

### Modelo de entrada externa

O requisito de `PeerAuthentication` em modo `STRICT` torna inviável expor diretamente cada workload com um `Service` do tipo `LoadBalancer` em cada namespace, porque clientes externos não possuem identidade mTLS da malha e não conseguiriam alcançar os pods diretamente.

Por isso, a solução usa:

- um único workload/`Service` `istio-ingressgateway` (`LoadBalancer`) em `istio-system`, compartilhado por todas as rotas externas
- duas `Gateway` do Istio: uma definida no namespace `service-1` e outra no namespace `service-3`, ambas selecionando esse mesmo workload `istio-ingressgateway` (`selector: istio: ingressgateway`)
- o `service-2` é intencionalmente acessível pela `Gateway` do `service-1` em `/service-2` apenas para demonstrar que essa rota direta é rejeitada; não existe um recurso `Gateway` separado para o `service-2`
- `VirtualService` para encaminhar requisições internas aos workloads

Esse desenho preserva:

- acesso externo controlado
- validação de `JWT` logo depois do ponto de entrada compartilhado
- `mTLS` interno obrigatório
- isolamento por namespace via `AuthorizationPolicy`

Nota sobre onde o JWT é de fato validado: o `Gateway` em si apenas termina o TLS e roteia o tráfego; ele não valida o JWT. O `RequestAuthentication` em `service-1` e `service-3` não tem `selector` de workload, então se aplica a todos os workloads daquele namespace, e a validação roda no sidecar Envoy do pod de destino, logo depois que o tráfego sai do Gateway compartilhado.

O par `Gateway`/`VirtualService` do `service-1` é também o que prova o requisito de isolamento do `service-2`. O `VirtualService` dessa `Gateway` define duas rotas baseadas em path: uma requisição para `/service-2` é roteada diretamente ao workload `service-2`, e uma requisição para `/service-1/service-2` é roteada ao workload `service-1` com o prefixo `/service-1` removido, e então a instância `wiremock` do `service-1` faz o proxy adiante para `service-2` usando a própria identidade da `ServiceAccount`. As duas requisições chegam ao sidecar Envoy do `service-2` via mTLS, mas apenas a segunda é aceita:

- `GET /service-2` na `Gateway` do `service-1` — a requisição chega ao `service-2` carregando o principal do `istio-ingressgateway`, que não é o `service-1`, então a `AuthorizationPolicy` do `service-2` a rejeita (`403`)
- `GET /service-1/service-2` na `Gateway` do `service-1` — a requisição passa primeiro pelo `service-1`, que então chama o `service-2` com sua própria identidade de `ServiceAccount`, então a `AuthorizationPolicy` do `service-2` a aceita (`200`)

É exatamente por isso que o `service-2` também é exposto diretamente de propósito: não porque falte rota até ele, mas para permitir demonstrar uma requisição que ignora a identidade do `service-1` e mostrar que ela é rejeitada pela `AuthorizationPolicy` baseada em identidade, e não por inalcançabilidade de rede.

Não existe uma rota catch-all em nenhuma das `Gateway`. Cada `VirtualService` só faz match de paths com o prefixo correspondente: `/service-1...`, `/service-2...` ou `/service-3...`. Um path como `/lucas` não corresponde a nenhuma rota e não é encaminhado para nenhum serviço da aplicação.

### Políticas aplicadas

- `PeerAuthentication` em modo `STRICT` nos namespaces `service-1`, `service-2` e `service-3`
- sem exceções por porta ou por workload: cada `PeerAuthentication` é o recurso `default` em nível de namespace, sem overrides de `portLevelMtls` e sem `selector` de workload, então o `STRICT` mTLS cobre todas as portas e todos os workloads dos três namespaces
- namespace com label `istio-injection=enabled` para habilitar a injeção automática de sidecar
- `RequestAuthentication` em `service-1` e `service-3` com JWKS público
- `AuthorizationPolicy`:
  - `service-1` exige JWT válido
  - `service-2` aceita apenas tráfego da `ServiceAccount` de `service-1`
  - `service-3` aceita apenas requisições vindas do ingress gateway e bloqueia `service-1` e `service-2`
- `DestinationRule` com `ISTIO_MUTUAL` para comunicação interna segura

---

## 3. Detalhes da implementação

### Cluster k3s

A stack usa:

- versão do k3s: `v1.37.0+k3s1`
- sistema operacional base: Ubuntu 24.04 (`bento/ubuntu-24.04`)
- rede privada da VM: `192.168.56.0/24`
- 3 nós em estado `Ready`

A configuração do cluster está em:

- `Vagrantfile`
- `ansible/playbooks/site.yaml`

### Service mesh

A instalação do Istio é controlada em:

- `k8s/istio/istio-operator.yaml`
- `k8s/helmfile.yaml.gotmpl`

A configuração usa o perfil `default`, com `ingressGateways` habilitado e sem egress gateway obrigatório para o escopo do desafio.

### Serviços

Os manifests e os valores do Helm estão em:

- `k8s/services/default-values.yaml.gotmpl`
- `k8s/services/service-1-values.yaml.gotmpl`
- `k8s/services/service-2-values.yaml.gotmpl`
- `k8s/services/service-3-values.yaml.gotmpl`

Os artefatos incluem:

- `PeerAuthentication`
- `RequestAuthentication`
- `AuthorizationPolicy`
- `Gateway`
- `VirtualService`
- `DestinationRule`
- `ScaledObject` (bônus)

### Método de deploy por serviço

Como exigido pelo desafio, cada serviço usa um método de deploy diferente:

- `service-1`: renderizado a partir dos templates Helm compartilhados e commitado como um manifest YAML estático em `k8s/services/raw-manifests/svc-1.yaml`, aplicado com `kubectl apply` puro (`task kapply:svc-1.yaml`) — nenhum `helm install`/`helmfile apply` é usado para esse serviço no momento do deploy.
- `service-2`: instalado como release Helm normal via `helmfile` (chart `stakater/application`).
- `service-3`: instalado como release Helm, usando a mesma família de chart do `service-2`. O desafio permite YAML ou Helm para esse serviço; o mesmo fluxo `helmfile template` + `kubectl apply` usado no `service-1` poderia ser aplicado aqui caso se prefira um deploy somente em YAML.

---

## 4. Configuração do JWT e JWKS

O projeto gera uma chave EC P-256 e publica a parte pública em `fake-vault/jwt/jwks.json`.

### Chaves

- `fake-vault/jwt/private.dec.jwk`
- `fake-vault/jwt/public.jwk`
- `fake-vault/jwt/jwks.json`

### Algoritmo e identidade

- algoritmo JWT: `ES256`
- curva: `P-256`
- emissor: `https://desafio-devops.local`
- `aud`: `service-1`, `service-2`, `service-3`
- `kid`: `desafio-devops-es256-1`

A configuração do `RequestAuthentication` usa a chave pública em `jwks.json` para validar a assinatura do token no Istio.

### Geração do token

O repositório já contém a rotina de geração via `Taskfile`:

```bash
# gerar chave e JWKS
 task jwk:setup

# gerar token válido
 task jwt:gen

# provar validação do token com o JWKS
 task jwt:test
```

Exemplo de geração manual:

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

## 5. Passo a passo reproduzível do zero

### Sistema operacional e ambiente

Este projeto foi desenvolvido para ser executado em Linux nativo. Alguns componentes dependem de recursos do Linux, incluindo KVM, libvirt, rede privada e as máquinas virtuais do k3s.

O uso do WSL não é recomendado para este projeto ao utilizar o provedor libvirt. Executar VMs libvirt pelo WSL exige um kernel personalizado e integrações adicionais de virtualização, que não fazem parte da configuração suportada. Prefira uma instalação nativa do Linux.

### Setup do autor (exemplo)

Minha máquina principal é Windows, pois uso algumas ferramentas de dados exclusivas dessa plataforma (Power BI, Excel, etc.). O Linux roda virtualizado por cima, então este desafio foi desenvolvido dentro de uma VM NixOS (uma distro Linux declarativa) no Hyper-V, acessada via SSH usando o VS Code Remote-SSH.

Para as VMs libvirt (nested) funcionarem de forma confiável sob o Hyper-V, precisei habilitar nested virtualization e MAC address spoofing no virtual switch usado pela VM do NixOS. A configuração do meu NixOS também exigiu duas mudanças, deixadas aqui como referência:

- [feat: add libvirt config · lucasfcnunes/dotfiles@62e7230](https://github.com/lucasfcnunes/dotfiles/commit/62e72309f1e5ff2e2d516882e6c01ed68a07f896) — habilita o `libvirtd`, permite tráfego entre bridges (`virbr*`/`vnet*`), ativa IP forwarding e desativa o reverse-path filtering estrito para o networking entre VMs funcionar.
- [chore: make nixos more flexible on /etc/hosts editing for dev · lucasfcnunes/dotfiles@4968406](https://github.com/lucasfcnunes/dotfiles/commit/4968406f0c565d89ca17ef57f31cca49811256df) — no NixOS, o `/etc/hosts` normalmente é um symlink read-only gerenciado pelo Nix, o que quebra o `hostctl`; essa mudança torna o `/etc/hosts` writable e sincroniza a partir do arquivo original gerenciado pelo Nix no boot.

Esse setup é específico da minha máquina e não é necessário para reproduzir o desafio — qualquer host Linux nativo (bare metal ou uma VM com nested virtualization habilitado) funciona.

### Ambiente de desenvolvimento recomendado

O VS Code é recomendado porque oferece terminal integrado, suporte de edição para YAML e Nix e um fluxo conveniente para executar as tarefas do projeto. Também é possível executar tudo em um terminal comum; o fluxo somente pelo terminal tem os mesmos recursos, mas oferece menos praticidade durante o desenvolvimento.

### Instalação do devenv

O `devenv` fornece as ferramentas declaradas em `devenv.nix`, incluindo Ansible, Vagrant, libvirt, QEMU/KVM, kubectl, Helm, Helmfile, k6, `step`, SOPS, Task e utilitários de apoio.

Instale o Nix com suporte a flakes:

```bash
curl -L https://nixos.org/nix/install | sh -s -- --daemon
```

Reinicie o terminal ou carregue o perfil do Nix e instale o `devenv`:

```bash
curl -L https://devenv.sh/install.sh | bash
```

Na raiz do repositório, autorize o projeto e entre no ambiente de desenvolvimento:

```bash
devenv allow
devenv shell
```

O projeto também oferece um atalho pelo Taskfile:

```bash
task devenv:setup
```

Ao utilizar `direnv`, o ambiente pode ser carregado automaticamente depois de instalar o `direnv` e executar:

```bash
direnv allow
```

O arquivo `devenv.nix` é a fonte oficial da configuração do ambiente. Ao usar o `devenv`, não é necessário instalar globalmente todas as dependências do projeto; entre no shell antes de executar os comandos.

### Pré-requisitos do Linux nativo

No host de desenvolvimento, instalar:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y curl git make jq yq libvirt-daemon libvirt-clients qemu-kvm ansible
```

Habilite o serviço do libvirt e garanta que o usuário atual tenha acesso aos recursos de virtualização:

```bash
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt,kvm "$USER"
```

Saia da sessão e entre novamente após alterar os grupos. Ao usar o ambiente `devenv` do repositório, as demais ferramentas são fornecidas automaticamente.

Além disso:

- `vagrant`
- `helm`
- `kubectl`
- `step`
- `sops`
- `mkcert`
- `task`

### 1) Clonar o repositório

```bash
git clone https://github.com/lucasfcnunes/desafio-devops-pleno.git
cd desafio-devops-pleno
```

### 2) Preparar as dependências do Ansible

```bash
task ansible:requirements-setup
```

### 3) Subir a infraestrutura

```bash
task vagrant:up
```

Esse comando provisiona:

- `server-0`
- `agent-0`
- `agent-1`

### 4) Copiar o kubeconfig

```bash
task kubeconfig:cp
```

### 5) Verificar o cluster

```bash
kubectl get nodes
kubectl get pods -A
```

Todos os nós devem estar em `Ready`.

### 6) Instalar o stack do Istio e suas dependências

```bash
task helmfile:sync
```

### 7) Instalar o manifest do `service-1`

```bash
task kapply:svc-1.yaml
```

### 8) Validar os serviços

```bash
task test
```

---

## 6. Validação dos requisitos

### 6.1 Cluster k3s funcional

```bash
kubectl get nodes
kubectl get nodes -o wide
```

Resultado esperado: 3 nós com estado `Ready`.

### 6.2 `PeerAuthentication` em modo `STRICT`

```bash
kubectl get peerauthentication -A
kubectl describe peerauthentication default -n service-1
kubectl describe peerauthentication default -n service-2
kubectl describe peerauthentication default -n service-3
```

Resultado esperado:

- `spec.mtls.mode: STRICT`
- aplicadas em todos os namespaces da aplicação

### 6.3 JWT: sem token, token inválido e token válido

Para `service-1`:

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

Resultados esperados:

- sem token → `403` (a `AuthorizationPolicy` do Istio nega a requisição porque `request.auth.principal` está vazio; o filtro de JWT não rejeita um token ausente por si só)
- token inválido → `401` (o próprio filtro de JWT rejeita a requisição porque a assinatura/issuer não pode ser validada)
- token válido → `200`

> O enunciado do desafio lista `401` para o caso de token ausente. Na prática, o `RequestAuthentication` do Istio trata um token ausente como anônimo, e não como inválido, então a rejeição acontece uma camada depois, na `AuthorizationPolicy`, resultando em `403`. Esse é o comportamento real observado ao rodar os comandos acima, e está documentado aqui para não ser confundido com uma configuração incorreta.

Repetir para `service-3`:

```bash
curl -i https://service-3.desafio-devops.local/service-3 \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

### 6.4 Bloqueio do acesso direto ao `service-2`

A regra de `AuthorizationPolicy` para `service-2` aceita apenas a principal da `ServiceAccount` do `service-1`:

```bash
kubectl describe authorizationpolicy service-2-only-from-service-1 -n service-2
```

Validação prática de dentro do cluster:

```bash
kubectl run netshoot --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'curl -I http://service-2.service-2.svc.cluster.local'
```

Resultado esperado: acesso recusado.

A mesma rejeição pode ser demonstrada pela própria `Gateway` do `service-1`, sem passar pela rota interna do `service-1`: o `VirtualService` roteia `/service-2` diretamente ao workload `service-2`, que então vê o principal do `istio-ingressgateway` em vez do `service-1` e nega a requisição.

```bash
curl -i https://service-1.desafio-devops.local/service-2 \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Resultado esperado: `403`, mesmo com um JWT válido, porque a requisição nunca passa pela identidade do próprio workload `service-1`.

Paths sem prefixo de serviço também não são roteados:

```bash
curl -i https://service-1.desafio-devops.local/lucas \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Resultado esperado: nenhuma rota da aplicação é selecionada; `/lucas` não é encaminhado para `service-1`, `service-2` ou `service-3`.

### 6.5 Isolamento do `service-3`

```bash
kubectl run netshoot --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'curl -I http://service-3.service-3.svc.cluster.local'
```

Ou, a partir de um pod em `service-1` ou `service-2`, tente acessar `service-3`.

Resultado esperado: acesso bloqueado por `AuthorizationPolicy`.

### 6.6 Roteamento interno via `service-1` -> `service-2`

```bash
curl -i https://service-1.desafio-devops.local/service-1/service-2 \
  -H "Authorization: Bearer $(cat ./fake-vault/jwt/token.dec.jwt)" \
  --cacert ./fake-vault/tls/rootCA.pem.crt
```

Resultado esperado: `200`. Diferente do path `/service-2` usado em [6.4](#64-bloqueio-do-acesso-direto-ao-service-2), o path `/service-1/service-2` é roteado pelo `VirtualService` primeiro ao workload `service-1` (com o prefixo `/service-1` removido); a instância `wiremock` do `service-1` então chama o `service-2` por conta própria, usando sua própria identidade de `ServiceAccount`, que é o que a `AuthorizationPolicy` do `service-2` permite.

---

## 7. Justificativa de decisões não triviais

### `libvirt` em vez de `VirtualBox`

- melhor encaixe para ambientes Linux com KVM/QEMU
- menor fricção em hosts de desenvolvimento baseados em Linux
- maior estabilidade e reprodutibilidade de execução

### Versão do k3s

- `v1.37.0+k3s1` foi escolhida para manter uma versão recente e compatível com o ecossistema moderno do Kubernetes
- a combinação com Ubuntu 24.04 também reduz incompatibilidades de sistema

### CNI e Istio

- o `k3s` usa Flannel por padrão
- o Istio é instalado com a pilha sidecar padrão e não depende de troca de CNI
- isso mantém a solução simples e reprodutível, sem adicionar dependências extras de rede

### `PeerAuthentication` em `STRICT`

- é o modo mais seguro exigido pelo desafio
- perde o acesso externo direto aos workloads por design
- a solução emprega o `Gateway` do Istio como borda e o `VirtualService` para o roteamento interno

### `ES256` em vez de `RS256`

- o repositório já gera e valida um JWK EC
- é um padrão moderno e leve para tokens JWT em ambiente de laboratório
- mantém o exemplo simples e compatível com o `RequestAuthentication` do Istio

### Uso de `ServiceAccount` explícita

- sem uma `ServiceAccount` nomeada, o Istio pode cair no valor `default`
- isso tornaria a política de identidade do `service-2` ambígua e quebraria a validação do principal com `source.principals`

### Escopo do `PeerAuthentication`: por namespace, não mesh-wide

- cada namespace de aplicação (`service-1`, `service-2`, `service-3`) recebe seu próprio `PeerAuthentication` `default` em nível de namespace, em vez de uma única política mesh-wide em `istio-system`
- isso mantém o requisito `STRICT` restrito exatamente aos namespaces de aplicação do desafio, sem forçar mTLS estrito em namespaces não relacionados (por exemplo `kube-system` ou `monitoring`), que podem ter workloads sem sidecar

### Endereçamento estático da rede privada das VMs

- o desafio não exige configuração manual de IP, `/etc/hosts` ou firewall, e nada disso foi feito manualmente para a comunicação entre nós
- os agentes do `k3s` ainda precisam saber o endereço do servidor antes de ele existir, então o `Vagrant` atribui endereços estáticos na rede privada (`192.168.56.0/24`); a rede em si continua sendo criada e gerenciada pelo `Vagrant`/`libvirt`, só o layout de endereços é fixo, para poder ser passado ao provisionamento do Ansible como um `api_endpoint` conhecido

### Imagem da aplicação (`wiremock`)

- o `wiremock/wiremock` foi escolhido como aplicação HTTP para os três serviços
- não exige código de aplicação customizado e já expõe uma resposta JSON de echo por padrão, útil para inspecionar headers e claims do JWT durante os testes
- seu motor de templating de respostas é usado para fazer proxy das requisições de `service-1` para `service-2` (`k8s/services/wiremock/mappings.yaml`), que é exatamente a chamada cross-namespace pedida pelo desafio

---

## 8. Bônus — autoscaling com KEDA + Prometheus

O repositório já inclui o suporte para observar métricas do Istio e escalar serviços com KEDA.

### Métrica escolhida

A métrica de referência no `ScaledObject` é:

```text
sum(rate(istio_requests_total{reporter="destination", destination_workload_namespace="<namespace>", destination_workload="<service>"}[1m]))
```

Ela mede o throughput de requisições por minuto em cada workload. Assim, sob carga, o KEDA aumenta o número de réplicas; ao remover a carga, realiza o scale-down.

### Instalação

O processo de instalação do Prometheus e do KEDA já está contemplado em:

- `k8s/helmfile.yaml.gotmpl`
- `k8s/kube-prometheus-stack/values.yaml.gotmpl`
- `k8s/keda/values.yaml.gotmpl`

### Script k6

O script de carga está em:

- `k6/test.js`

Ele gera tokens JWT e executa requisições em massa nos endpoints expostos por `service-1` e `service-3`.

### Execução

```bash
cd ./k6
k6 run ./test.js
```

O comportamento esperado é:

- aumento de réplicas do `ScaledObject`
- estabilização sob alta carga
- redução de réplicas ao encerrar a carga

```bash
kubectl get hpa -A
kubectl get pods -n service-1 -w
```

---

## 9. Estrutura do repositório

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

## 10. Observações finais

Este desafio foi implementado com foco em:

- reprodutibilidade
- segurança por padrão
- uso real de service mesh e mTLS
- autenticação de entrada com JWT
- separação clara de responsabilidades entre ingress, workload e políticas de acesso

A implementação está alinhada ao enunciado e reflete o desenho recomendado para um cluster Kubernetes com Istio em modo strict, mantendo o cenário de produção em escala laboratorial e de fácil reprodução.
