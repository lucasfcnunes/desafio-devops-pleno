#!/bin/sh

istioctl manifest generate -f "$(cd "$(dirname "$0")" && pwd)/istio-operator.yaml" | \
yq 'del(.webhooks[].failurePolicy)' | \
yq eval-all -P 'select(. != null) | [.]'
