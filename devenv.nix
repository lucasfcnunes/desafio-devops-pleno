{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
{
  # https://devenv.sh/basics/
  env.VAGRANT_WSL_ENABLE_WINDOWS_ACCESS = "1";
  env.LIBVIRT_DEFAULT_URI = "qemu:///session";
  env.VAGRANT_LIBVIRT_URI = config.env.LIBVIRT_DEFAULT_URI;
  env.VAGRANT_DEFAULT_PROVIDER = "virtualbox";
  # process.managers.process-compose.enable = true;

  # https://devenv.sh/packages/
  packages = [
    pkgs.sops
    pkgs.ansible
    pkgs.go-task
    # pkgs.libvirt
    # pkgs.qemu_kvm
    # pkgs.virt-manager
    # pkgs.cdrtools
    pkgs.virtualbox
    pkgs.git
    # pkgs.vagrant
    (pkgs.vagrant.overrideAttrs (oldAttrs: {
      doInstallCheck = false;
      postInstall = oldAttrs.postInstall + ''
        echo '{"version":"1","installed":{}}' > "$out/vagrant-plugins/plugins.json"
        # TODO: https://github.com/NixOS/nixpkgs/issues/348108
        # wrapProgram "$out/bin/vagrant" \
        # --set-default VAGRANT_LIBVIRT_URI ${config.env.VAGRANT_LIBVIRT_URI} \
        # --set VAGRANT_WSL_ENABLE_WINDOWS_ACCESS 1 \
        # --prefix PATH ':' "/mnt/c/Windows/system32/"
      '';
    }))
  ];

  # processes = {
  #   # Run virtqemud (modular daemon) isolated inside .devenv state directory
  #   virtqemud = {
  #     exec = ''
  #       export XDG_RUNTIME_DIR="$DEVENV_RUNTIME"
  #       export XDG_CONFIG_HOME="$DEVENV_STATE/config"
  #       export XDG_DATA_HOME="$DEVENV_STATE/share"

  #       mkdir -p "$DEVENV_RUNTIME/libvirt" "$DEVENV_STATE/libvirt/images"
  #       exec ${pkgs.libvirt}/bin/virtqemud
  #     '';
  #   };
  # };
  # https://devenv.sh/languages/
  # languages.rust.enable = true;

  # https://devenv.sh/processes/
  # processes.dev.exec = "${lib.getExe pkgs.watchexec} -n -- ls -la";

  # https://devenv.sh/services/
  # services.postgres.enable = true;

  # https://devenv.sh/scripts/
  # Pre-configure user storage pool inside the devenv state directory
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

  # https://devenv.sh/basics/
  enterShell = ''
    # SHORT_HASH=$(echo -n "$PWD" | md5sum | cut -c1-8)
    # export SHORT_DEVENV_RUNTIME="/tmp/dev-$SHORT_HASH"
    # # mkdir -p "$SHORT_DEVENV_RUNTIME"
    # # rm -f "$SHORT_DEVENV_RUNTIME"
    # # ln -sfn "$DEVENV_RUNTIME" "$SHORT_DEVENV_RUNTIME"

    # export XDG_DATA_HOME="$DEVENV_STATE/share"
    # export XDG_CONFIG_HOME="$DEVENV_STATE/config"
    # export XDG_RUNTIME_DIR="$DEVENV_RUNTIME"
    # # export XDG_RUNTIME_DIR="$SHORT_DEVENV_RUNTIME"

    # mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"
    # echo "Libvirt user environment initialized. Target URI: $LIBVIRT_DEFAULT_URI"
  '';

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # https://devenv.sh/tests/
  enterTest = ''
    echo "Running tests"
    git --version | grep --color=auto "${pkgs.git.version}"
    test -w /dev/kvm && virsh capabilities | grep -i kvm
  '';

  # https://devenv.sh/git-hooks/
  # git-hooks.hooks.shellcheck.enable = true;

  # See full reference at https://devenv.sh/reference/options/
}
