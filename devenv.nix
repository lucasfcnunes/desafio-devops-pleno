{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
{
  name = "desafio-devops.lucasfcnunes.com";
  # https://devenv.sh/basics/
  env.KUBECTL_EXTERNAL_DIFF = "dyff between --omit-header --set-exit-code";
  env.HELM_DIFF_OUTPUT = "dyff";
  env.HELM_DIFF_THREE_WAY_MERGE = "true";
  env.VAGRANT_WSL_ENABLE_WINDOWS_ACCESS = "1";
  env.PROJECT_ROOT = config.git.root;
  env.KUBECONFIG = "${config.env.PROJECT_ROOT}/fake-vault/.kube/k3s.yaml";
  env.SOPS_AGE_KEY_FILE = "${config.env.PROJECT_ROOT}/fake-vault/age-key.txt";

  # process.manager.implementation = "process-compose";
  # process.manager.implementation = "native";
  # env.INSTALL_SERVICE_1 = "true"; # ! comment this by default
  env.NODES_SUBNET = "192.168.56.0/24";
  env.STARTING_NODE_INDEX = "10";
  hostsProfileName = config.name;
  hosts =
    let
      nodes_ip = [
        "192.168.56.10"
        "192.168.56.11"
        "192.168.56.12"
      ];
    in
    {
      "*.desafio-devops.local" = nodes_ip;
      "service-1.desafio-devops.local" = nodes_ip;
      # "service-2.desafio-devops.local" = nodes_ip;
      "service-3.desafio-devops.local" = nodes_ip;
      "*.desafio-devops.lucasfcnunes.com" = nodes_ip;
    };
  certificates = [
    "*.desafio-devops.local"
    "service-1.desafio-devops.local"
    # "service-2.desafio-devops.local"
    "service-3.desafio-devops.local"
    "*.desafio-devops.lucasfcnunes.com"
  ];

  # https://devenv.sh/packages/
  packages =
    let
      my-kubernetes-helm =
        with pkgs;
        wrapHelm kubernetes-helm {
          plugins = with pkgs.kubernetes-helmPlugins; [
            helm-secrets
            helm-diff
            helm-s3
            helm-git
            helm-unittest
          ];
        };
      my-helmfile = pkgs.helmfile-wrapped.override {
        inherit (my-kubernetes-helm) pluginsDir;
      };
      my-vagrant = (
        pkgs.vagrant.overrideAttrs (oldAttrs: {
          doInstallCheck = false;
          postInstall = oldAttrs.postInstall + ''
            echo '{"version":"1","installed":{}}' > "$out/vagrant-plugins/plugins.json"
            # TODO: https://github.com/NixOS/nixpkgs/issues/348108
            # wrapProgram "$out/bin/vagrant" \
            # --set-default VAGRANT_LIBVIRT_URI $\{config.env.VAGRANT_LIBVIRT_URI} \
            # --set VAGRANT_WSL_ENABLE_WINDOWS_ACCESS 1 \
            # --prefix PATH ':' "/mnt/c/Windows/system32/"
          '';
        })
      );
    in
    [
      # pkgs.direnv # ! OPTIONAL: install and run `direnv allow` OR run `devenv shell`
      pkgs.istioctl
      pkgs.k6
      pkgs.step-cli
      pkgs.sops
      pkgs.age
      pkgs.ansible
      pkgs.go-task
      pkgs.yq-go
      pkgs.kubectl
      my-kubernetes-helm
      my-helmfile
      pkgs.dyff
      pkgs.git
      # pkgs.vagrant
      my-vagrant
    ]
    ++ [
      pkgs.hostctl
      pkgs.mkcert
      pkgs.nssTools # Required if using Firefox or Chrome NSS stores
      pkgs.curl
    ];

  profiles = {
    user.lucasfcnunes = {
      module = {
        packages = [
          # pkgs.hurl
          pkgs.ripgrep
          pkgs.k9s
          pkgs.jujutsu
          pkgs.jjui
        ];
      };
    };
    qemu-session = {
      # INFO: as opposed to qemu:///system, qemu:///session does not require root privileges,
      # INFO: but it has some limitations (e.g., no access to host devices)
      # TODO: make it work with qemu://session too (hard?)
      module = {
        env.LIBVIRT_DEFAULT_URI = "qemu:///session";
        env.VAGRANT_LIBVIRT_URI = config.env.LIBVIRT_DEFAULT_URI;
        env.VAGRANT_DEFAULT_PROVIDER = "libvirt";
        # env.VAGRANT_DEFAULT_PROVIDER = "virtualbox";
        packages = [
          pkgs.libvirt
          pkgs.qemu_kvm
          pkgs.virt-manager
          pkgs.cdrtools
          # pkgs.virtualbox
        ];
        processes = {
          # Run virtqemud (modular daemon) isolated inside .devenv state directory
          virtqemud = {
            exec = ''
              export XDG_RUNTIME_DIR="$DEVENV_RUNTIME"
              export XDG_CONFIG_HOME="$DEVENV_STATE/config"
              export XDG_DATA_HOME="$DEVENV_STATE/share"

              mkdir -p "$DEVENV_RUNTIME/libvirt" "$DEVENV_STATE/libvirt/images"
              exec ${pkgs.libvirt}/bin/virtqemud
            '';
          };
        };

        scripts.init-libvirt-pool.exec = ''
          set -euo pipefail
          POOL_DIR="$DEVENV_STATE/libvirt/images"
          mkdir -p "$POOL_DIR"

          # Define pool if it does not already exist
          if ! virsh pool-info default >/dev/null 2>&1; then
            echo "Creating default storage pool in $POOL_DIR..."
            virsh pool-define-as default dir --target "$POOL_DIR"
            virsh pool-build default
            virsh pool-start default
            virsh pool-autostart default
          else
            echo "Storage pool 'default' is already configured."
          fi
        '';
        # Define and start an ephemeral test domain
        scripts.run-test-domain.exec = ''
          set -euo pipefail

          virsh uri
          virsh list --all

          # Generate minimal XML definition for an unprivileged domain
          cat <<EOF > "$DEVENV_STATE/test-vm.xml"
          <domain type='kvm'>
            <name>devenv-node</name>
            <memory unit='KiB'>1048576</memory>
            <vcpu placement='static'>2</vcpu>
            <os>
              <type arch='x86_64' machine='q35'>hvm</type>
              <boot dev='hd'/>
            </os>
            <features>
              <acpi/>
              <apic/>
            </features>
            <clock offset='utc'/>
            <on_poweroff>destroy</on_poweroff>
            <on_reboot>restart</on_reboot>
            <on_crash>destroy</on_crash>
            <devices>
              <emulator>${pkgs.qemu_kvm}/bin/qemu-system-x86_64</emulator>
              <interface type='user'>
                <mac address='52:54:00:12:34:56'/>
                <model type='virtio'/>
              </interface>
              <console type='pty'>
                <target type='serial' port='0'/>
              </console>
            </devices>
          </domain>
          EOF

          # Define and launch
          virsh define "$DEVENV_STATE/test-vm.xml"
          virsh start devenv-node || true
          virsh list --all
        '';
        enterTest = ''
          test -w /dev/kvm && virsh capabilities | grep -i kvm
        '';
        enterShell = ''
          # SHORT_HASH=$(echo -n "$PWD" | md5sum | cut -c1-8)
          # export SHORT_DEVENV_RUNTIME="/tmp/dev-$SHORT_HASH"
          # mkdir -p "$SHORT_DEVENV_RUNTIME"
          # rm -f "$SHORT_DEVENV_RUNTIME"
          # ln -sfn "$DEVENV_RUNTIME" "$SHORT_DEVENV_RUNTIME"

          export XDG_DATA_HOME="$DEVENV_STATE/share"
          export XDG_CONFIG_HOME="$DEVENV_STATE/config"
          export XDG_RUNTIME_DIR="$DEVENV_RUNTIME"
          # export XDG_RUNTIME_DIR="$SHORT_DEVENV_RUNTIME"

          mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"
          echo "Libvirt user environment initialized. Target URI: $LIBVIRT_DEFAULT_URI"
        '';
      };
    };
  };

  # https://devenv.sh/languages/
  # languages.rust.enable = true;

  # https://devenv.sh/processes/
  # processes.dev.exec = "${lib.getExe pkgs.watchexec} -n -- ls -la";
  processes = {
    # sleep = {
    #   exec = "${pkgs.coreutils}/bin/sleep infinity";
    # };
    # svc-postgres.exec = ''
    #   while true; do
    #     kubectl port-forward svc/postgres-service 5432:5432 -n database
    #     sleep 2
    #   done
    # '';
    # pf-prometheus.exec = "kubectl port-forward -n monitoring svc/kps-prometheus 9090:9090";
    # pf-grafana.exec = "kubectl port-forward -n monitoring svc/kps-grafana 80:3000";
    # pf-kiali.exec = "kubectl port-forward -n istio-system svc/kiali 20001:20001";
    pf-prometheus.exec = "istioctl dashboard -n monitoring prometheus";
    pf-grafana.exec = "istioctl dashboard -n monitoring grafana";
    pf-kiali.exec = "istioctl dashboard kiali";
    # pf-proxy-svc-1.exec = "istioctl dashboard proxy svc/service-1.service-1";
    # pf-proxy-svc-2.exec = "istioctl dashboard proxy svc/service-2.service-2";
    # pf-proxy-svc-3.exec = "istioctl dashboard proxy svc/service-3.service-3";
  };

  # https://devenv.sh/services/
  # services.postgres.enable = true;

  # https://devenv.sh/scripts/
  # Pre-configure user storage pool inside the devenv state directory

  # https://devenv.sh/basics/
  enterShell = ''
    echo "Running shell..."
    echo "Shell done."
  '';

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # https://devenv.sh/tests/
  enterTest = ''
    echo "Running tests"
    echo "Tests done."
  '';

  # https://devenv.sh/git-hooks/
  # git-hooks.hooks.shellcheck.enable = true;

  # See full reference at https://devenv.sh/reference/options/
  cachix.pull = [
    "lucasfcnunes"
  ];
  git-hooks.hooks = {
    treefmt.enable = true;
    pre-commit-hook-ensure-sops.enable = true;
  };
  treefmt = {
    enable = true;
    config.programs = {
      nixfmt.enable = true;
      actionlint.enable = true;
      prettier.enable = true;
      # TODO: auto format ruby and yaml
      # prettier.settings = {
      #   plugins = [
      #     pkgs.prettier-plugin-ruby # "@prettier/plugin-ruby"
      #   ];
      #   overrides = [
      #     {
      #       files = [
      #         "Vagrantfile"
      #         "*.rb"
      #       ];
      #       options.parser = "ruby";
      #     }
      #   ];
      # };
    };
  };
}
