# How logging in to my servers works

This is a plain-language explainer for the home infrastructure in [ADR 0045](adr/0045-self-hosted-home-infrastructure.md). It needs no Linux background. Read it again whenever a command or a login prompt stops making sense.

## Users: who is allowed to do what

A computer can have several user accounts, and each account is a separate person (or program) with its own home folder and its own limits. A normal user can read and change its own files and whatever it has been explicitly given, and nothing else. If an account is hacked or makes a mistake, the damage stops at that account's limits. That is the whole reason for having more than one account.

One account is special: `root`. It has no limits at all. It can read every file, delete anything, install anything and break the machine in one command. That power is exactly why we avoid logging in as root. A typo as root can wipe a disk, and an attacker who gets root owns everything on the machine. So on the Debian machines, root has no password and nobody can log in as it. On the Proxmox machines, root keeps a password only because the Proxmox web page expects to log in as root.

I use the same daily account on every machine. It is a normal user, but it is allowed to use `sudo`. Sudo means "run this one command with root's power, after proving it is really me". It is root's power on loan, one command at a time, and it asks for my password each time. That is safer than being root all the time: I only borrow the power when a command needs it, and a stolen login for that account still has to know the password to do anything dangerous.

During setup I turn off the password check for sudo, so an AI can run commands I approve without me typing a password into its session. That rule lives in `/etc/sudoers.d/90-bringup`, and the last task (#226) removes it. After that, sudo asks for the password again.

Other accounts exist only for a specific program. `hermes` runs the Hermes agents on `stacy` and `tyler`. It has no sudo and no password, and cannot log in over SSH. So if an agent is tricked into doing something harmful, it can only damage `hermes`'s own files, not the machine. Later, `coder` will run coding sessions and `deploy` will run Quantself, each inside its own virtual machine. A machine should have exactly the accounts its job needs and no more, which is why the setup deletes the account created by the installer once my daily account works.

## Passwords and SSH keys: two ways to prove it is me

A password is a secret I type. The server doesn't store the password itself, only a scrambled version of it, and checks that what I type scrambles to the same thing. The weakness is that anyone who guesses or steals the password can try it from anywhere in the world. That is why, in task 3, I switch off password logins over SSH completely. Passwords stay for two things only: typing at the machine's own keyboard, and approving sudo.

An SSH key is a pair of two linked files, and the pair works like a padlock and its key. The public half is the padlock: it is fine for anyone to see, and I put a copy on every server. The private half is the key: it never leaves my control and sits in Proton Pass. When I connect, the server says "prove you hold the key that fits this padlock". My Mac asks the Proton Pass agent to answer, and the agent does it without ever handing the key over. The server checks the answer against its copy of the public half and lets me in. Nothing secret crosses the network, so there is nothing to guess and nothing to steal on the way.

So each of these has two places where it is stored, and mixing them up is the usual source of confusion:

| | What the server keeps | What I keep |
| --- | --- | --- |
| Password | a scrambled version | the real one, in Proton Pass |
| SSH key | the public half, in `~/.ssh/authorized_keys` | the private half, in Proton Pass |

Anyone who gets the server's copy can't log in with it. Only what I keep is dangerous, and it all sits in one place: Proton Pass. That is also why the personal key never goes onto a server. The agents on the servers get their own separate, limited keys.

There is a third thing that looks similar but goes the other direction: `known_hosts` on my Mac. The first time I connect to a machine, my Mac asks "are you sure you want to connect?" and then remembers the machine's fingerprint. Next time, if the fingerprint is different, SSH warns me that someone else may be pretending to be that machine. It protects me from fake servers, the way the key protects the servers from fake me.

## Tailscale and SSH: how they fit together

SSH is the way I log in to a machine and run commands on it. Tailscale is a private network. It gives every one of my machines a private address and a name, and makes them reachable from each other and from my Mac and phone, wherever I am, as if they were in one room. Nobody else on the internet can see or reach those addresses.

They do different jobs, and I use both. Tailscale answers "can my Mac reach that machine at all?", and the answer is yes only for my own devices. SSH answers "who are you, and may you come in?", and the answer is yes only with my key. So `ssh <owner-user>@<tailscale-host>` travels over Tailscale and logs in with the Proton key exactly as it would anywhere else. Tailscale never sees my key and never replaces it. We don't use Tailscale's own SSH feature, so there is only one way of logging in to learn.

Before Tailscale is set up, I reach a machine by its home network address. That address is handed out by the router and can change. After Tailscale, I use the machine's name and don't care what the home address is. That is why the router reservations aren't needed.

Tailscale also lets me put labels, called tags, on the servers (`tag:agent`, `tag:dev`, and so on) and write rules such as "agents may reach the Quantself API but not the backup machine". Tags and rules are settings in my Tailscale account, not secrets. The only thing to protect there is the Tailscale account itself, with two-step login turned on, because whoever controls it controls the rules.

## Where WireGuard fits with n8n

[WireGuard](https://www.wireguard.com/) creates an encrypted network link. Each computer keeps its own private key and uses the other computer's public key to verify who it is talking to. The two computers can then exchange traffic over the existing network without exposing its contents to other devices on that network.

I open the n8n editor over Tailscale from my Mac or iPhone using its URL from the private deployment configuration. When the Assistant needs to run code, the editor sends the request over a separate WireGuard link to the sandbox VM on Keep. The sandbox also checks the editor's own API key. The model runs at OpenAI and sandbox code runs on Keep. See the [architecture notes](adr/0045-self-hosted-home-infrastructure.md#n8n-assistant-on-keep).

## If I get locked out

Every machine still has its keyboard and screen. Logging in there with my daily account and password works even if SSH or Tailscale is broken, which is the reason the passwords are saved in Proton Pass and the keyboard login is never switched off. Root being locked on the Debian machines is fine for that reason: my daily account with sudo can do everything root can.
