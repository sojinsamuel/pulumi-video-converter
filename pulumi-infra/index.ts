// FILE: pulumi-infra/index.ts (Corrected Version 2)

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// --- Configuration ---
const config = new pulumi.Config();
// Instance type for EC2, defaulting to t2.micro (free tier eligible)
const instanceType = config.get("instanceType") || "t2.micro";
// **Placeholder for your app's GitHub repo URL - we'll set this later!**
const appRepoUrl = config.require("appRepoUrl"); // Use require to ensure it's set

// --- Networking (Using Default VPC) ---
// Get the default VPC and Subnets for simplicity
const vpc = aws.ec2.getVpc({ default: true });
const vpcId = vpc.then(v => v.id);
// CORRECTED LINE AGAIN: Use getSubnets with the 'filters' argument structure
const subnetIds = vpc.then(v => aws.ec2.getSubnets({
    filters: [{ name: "vpc-id", values: [v.id] }]
})).then(s => s.ids);

// --- Security Groups ---

// Security Group for the Application Load Balancer (ALB)
// Allows public HTTP traffic on port 80
const albSg = new aws.ec2.SecurityGroup("alb-sg", {
    vpcId: vpcId,
    description: "Allow HTTP inbound traffic for ALB",
    ingress: [{ // Allow HTTP from anywhere
        protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"],
    }],
    egress: [{ // Allow all outbound traffic
        protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"],
    }],
    tags: { Name: "video-converter-alb-sg" },
});

// Security Group for the EC2 Instance
// Allows traffic from ALB on port 3001 and SSH (restrict SSH IP later!)
const instanceSg = new aws.ec2.SecurityGroup("instance-sg", {
    vpcId: vpcId,
    description: "Allow HTTP from ALB and SSH",
    ingress: [
        { // Allow HTTP traffic on port 3001 ONLY from the ALB
            protocol: "tcp", fromPort: 3001, toPort: 3001, securityGroups: [albSg.id],
        },
        { // Allow SSH traffic on port 22 - **IMPORTANT: Restrict this CIDR block!**
            protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"], // <-- Change to your IP/32
        },
    ],
    egress: [{ // Allow all outbound traffic (for apt-get, git clone, npm, catbox)
        protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"],
    }],
    tags: { Name: "video-converter-instance-sg" },
});

// --- EC2 Instance ---

// Find the latest Ubuntu 22.04 LTS AMI (Jammy) for amd64
const ami = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"] },
        { name: "virtualization-type", values: ["hvm"] },
    ],
    mostRecent: true,
    owners: ["099720109477"], // Canonical's AWS account ID
});
// <!-- GIF: Finding AMI ID in AWS Console (optional alternative) -->

// EC2 Key Pair (Assumes you have an existing key pair created in AWS)
// **IMPORTANT**: Replace "your-key-pair-name" with the name of your actual EC2 Key Pair
const keyPairName = config.get("keyPairName") || "your-key-pair-name"; // Set via `pulumi config set keyPairName your-key-name` or here
// <!-- GIF: Showing where to find/create Key Pairs in AWS Console -->

// User data script to bootstrap the Ubuntu instance
const userData = pulumi.interpolate`#!/bin/bash
# Update package list and install dependencies
sudo apt-get update -y
sudo apt-get install -y git nodejs npm ffmpeg

# Clone the application repository (URL is injected by Pulumi config)
git clone ${appRepoUrl} /home/ubuntu/app
cd /home/ubuntu/app

# Install application dependencies
npm install

# Create uploads directory and set permissions
mkdir -p uploads
sudo chown ubuntu:ubuntu uploads

# Install pm2 to manage the Node.js process
sudo npm install pm2 -g
# Start the server using pm2
pm2 start server.js --name video-converter
# Ensure pm2 restarts on reboot
pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save
`;

// Create the EC2 instance
const instance = new aws.ec2.Instance("app-instance", {
    instanceType: instanceType,
    ami: ami.then(a => a.id),
    vpcSecurityGroupIds: [instanceSg.id],
    subnetId: subnetIds.then(ids => ids[0]), // Use the first default subnet
    keyName: keyPairName, // Assign your key pair for SSH access
    userData: userData, // Run the setup script on launch
    tags: { Name: "video-converter-instance" },
});

// --- Application Load Balancer (ALB) ---

// Create the ALB, Target Group, and Listener
const alb = new aws.lb.LoadBalancer("app-lb", {
    internal: false,
    loadBalancerType: "application",
    securityGroups: [albSg.id],
    subnets: subnetIds, // Assign the ALB to the default subnets
    tags: { Name: "video-converter-alb" },
});

const targetGroup = new aws.lb.TargetGroup("app-tg", {
    port: 3001, protocol: "HTTP", targetType: "instance", vpcId: vpcId,
    healthCheck: { // Basic health check for the root path
        path: "/", protocol: "HTTP", matcher: "200-399", interval: 30, timeout: 5,
        healthyThreshold: 2, unhealthyThreshold: 2,
    },
    tags: { Name: "video-converter-tg" },
});

const targetGroupAttachment = new aws.lb.TargetGroupAttachment("app-tg-attachment", {
    targetGroupArn: targetGroup.arn,
    targetId: instance.id,
    port: 3001,
});

const listener = new aws.lb.Listener("app-listener", {
    loadBalancerArn: alb.arn,
    port: 80, protocol: "HTTP",
    defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
});

// --- Outputs ---
// Export the public DNS name of the ALB so we can access the app
export const albUrl = alb.dnsName;
// Export the instance ID for reference
export const instanceId = instance.id;