# Desafio DevOps Pleno

## Nota sobre o uso de LoadBalancer

Neste projeto, o termo LoadBalancer foi interpretado como ponto de entrada externo da malha (edge), e nao como exposicao direta de cada workload de aplicacao.

A implementacao usa um unico Gateway do Istio exposto por um Service do tipo LoadBalancer no namespace istio-system. O roteamento para os servicos de aplicacao e feito por VirtualService.

### Justificativa tecnica

- O desafio exige PeerAuthentication em modo STRICT nos namespaces de aplicacao.
- Em STRICT, clientes externos sem identidade mTLS da malha nao conseguem acessar diretamente os pods de workload sem um ponto de terminacao/entrada apropriado.
- O modelo recomendado no Istio e expor externamente o Ingress Gateway (LoadBalancer) e manter workloads internos protegidos por politicas da malha.

### Conformidade com os requisitos

- Ha acesso externo via LoadBalancer.
- A validacao de JWT continua aplicada em service-1 e service-3 com RequestAuthentication e AuthorizationPolicy.
- O trafego interno entre workloads permanece protegido pelo modelo de mTLS da malha.
- O isolamento de service-3 em relacao aos demais servicos permanece aplicado por AuthorizationPolicy.

### Risco da interpretacao literal por workload

Uma leitura estritamente literal de "service-1 e service-3 com Service tipo LoadBalancer" pode conflitar com o objetivo de seguranca em STRICT no nivel de namespace. Por isso, foi adotado o desenho de referencia de service mesh: LoadBalancer no gateway de borda e workloads roteados internamente.
