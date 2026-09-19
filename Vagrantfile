# https://github.com/k3s-io/k3s-ansible/blob/dccb5ed4ad7f33fbb4ce76382620f08b28335c3e/Vagrantfile
require 'ipaddr'

# ENV['VAGRANT_NO_PARALLEL'] = 'no'
NODE_ROLES = ["server-0", "agent-0", "agent-1"]
# NODE_BOXES = ['boxen/nixos-25.05', 'boxen/nixos-25.05', 'boxen/nixos-25.05']
NODE_BOXES = ['bento/ubuntu-24.04', 'bento/ubuntu-24.04', 'bento/ubuntu-24.04']
# NODE_CPUS = 2
# NODE_MEMORY = 2048
NODE_CPUS = 4
NODE_MEMORY = 4096
# Virtualbox >= 6.1.28 require `/etc/vbox/network.conf` for expanded private networks 
NODES_SUBNET = IPAddr.new("192.168.56.0/24")
def get_node_ip(node_num)
  return (NODES_SUBNET.to_range.to_a[10 + node_num]).to_s
end
SERVER_API_IP = get_node_ip(0)

def provision(vm, role, node_num)
  vm.box = NODE_BOXES[node_num]
  vm.hostname = role
  # We use a private network because the default IPs are dynamically assigned 
  # during provisioning. This makes it impossible to know the server-0 IP when 
  # provisioning subsequent servers and agents. A private network allows us to
  # assign static IPs to each node, and thus provide a known IP for the API endpoint.
  node_ip = get_node_ip(node_num)
  # An expanded netmask is required to allow VM<-->VM communication, virtualbox defaults to /32
  # vm.network "private_network", hostname: true, ip: node_ip, netmask: NETMASK
  vm.network "private_network",
    hostname: true,
    libvirt__forward_mode: "nat",
    libvirt__dhcp_enabled: true,
    # libvirt__network_name: NETWORK_NAME,
    libvirt__network_address: NODES_SUBNET.to_s + "/" + NODES_SUBNET.prefix.to_s,
    ip: node_ip
  # vm.network "private_network", type: "dhcp"
  # vm.network "forwarded_port", guest: 6443, host: 1443 + node_num, host_ip: "0.0.0.0"

  vm.synced_folder "./", "/vagrant", automount: false

  vm.provision "ansible", run: 'once' do |ansible|
    ansible.compatibility_mode = "2.0"
    # ansible.playbook = "ansible/k3s-ansible/playbooks/site.yml"
    ansible.playbook = "./ansible/playbooks/site.yaml"
    ansible.groups = {
      "server" => NODE_ROLES.grep(/^server/),
      "agent" => NODE_ROLES.grep(/^agent/),
      "k3s_cluster:children" => ["server", "agent"],
    }
    ansible.extra_vars = {
      k3s_version: "v1.37.0+k3s1",
      api_endpoint: SERVER_API_IP,
      # Required for vagrant ansible provisioner
      token: "myvagrant",
      # Required to use the private network configured above
      extra_server_args: "--node-external-ip #{node_ip} --flannel-iface eth1", 
      extra_agent_args: "--node-external-ip #{node_ip} --flannel-iface eth1",
      # Airgap setup, left as reference
      # airgap_dir: "./my_airgap",
      # Optional, left as reference for ruby-ansible syntax
      # extra_service_envs: [ "NO_PROXY='localhost'" ],
      server_config_yaml: <<~YAML
        # write-kubeconfig-mode: 644
        # kube-apiserver-arg:
        #   - advertise-port=1234
        # flannel-backend: 'none'
        disable:
          - traefik
          # - coredns
      YAML
      # agent_config_yaml: <<~YAML
      #   with-node-id: true
      #   node-label:
      #     - "foo=bar"
      #     - "hello=world"
      # YAML
    }
  end
end

Vagrant.configure("2") do |config|
  # Default provider is virtualbox, libvirt is only provided as a backup
  # config.vm.provider "virtualbox" do |v|
  #   v.cpus = NODE_CPUS
  #   v.memory = NODE_MEMORY
  #   v.linked_clone = true
  # end
  config.vm.provider "libvirt" do |v|
    v.nested = true
    v.cpu_mode = "host-passthrough"
    v.cpus = NODE_CPUS
    v.memory = NODE_MEMORY
    v.qemu_use_session = false
    # v.driver = "qemu"
    v.driver = "kvm"
    v.management_network_name = "vagrant-libvirt"
  end

  NODE_ROLES.each_with_index do |name, i|
    config.vm.define name do |node|
      provision(node.vm, name, i)
    end
  end
end
