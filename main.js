const { Telegraf } = require('telegraf');
const { Connection, PublicKey } = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAccount,
} = require('@solana/spl-token');
require('dotenv').config();

const ADDRESSES_TO_CHECK = require('./config/addrs.config');
const ECLIPSE_RPC = require('./config/network.config');
const SPL_TOKEN_MINT_ADDRESS = require('./config/token.config');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const bot = new Telegraf(TELEGRAM_TOKEN);
const connection = new Connection(ECLIPSE_RPC, 'confirmed');

let userAddresses = new Map();
let lastBalances = new Map();
let knownTokenAccounts = new Map();

bot.start((ctx) => {
    console.log(`Received /start command from chat ID: ${ctx.chat.id}`);
    ctx.reply('Welcome! Use /add <address> to add a Solana address to track ES token balance.');
});

bot.command('add', async (ctx) => {
    const chatId = ctx.chat.id;
    const address = ctx.message.text.split(' ')[1];
    console.log(`Received /add command for address: ${address}, chat ID: ${chatId}`);

    if (!address) {
        console.log(`No address provided for /add command, chat ID: ${chatId}`);
        return ctx.reply('Please provide an address: /add <address>');
    }

    try {
        new PublicKey(address);
        console.log(`Validated address: ${address}`);

        if (!userAddresses.has(chatId)) {
            userAddresses.set(chatId, new Set());
            console.log(`Initialized address set for chat ID: ${chatId}`);
        }
        userAddresses.get(chatId).add(address);
        console.log(`Added address: ${address} to chat ID: ${chatId}`);

        await ctx.reply(`Added address ${address} for tracking.`);

        const { balance, tokenAccount } = await getTokenBalance(address, chatId);
        lastBalances.set(address, balance);
        if (tokenAccount) {
            knownTokenAccounts.set(address, new Set([tokenAccount]));
        }
        console.log(`Initial balance for ${address}: ${balance} ES`);
        console.log(`Initial token account for ${address}: ${tokenAccount}`);
    } catch (error) {
        console.error(`Invalid address: ${address}, error:`, error);
        await ctx.reply('Invalid Solana address. Please try again.');
    }
});

async function getTokenBalance(address, chatId) {
    try {
        console.log(`Fetching balance for address: ${address}`);
        const owner = new PublicKey(address);
        const tokenMint = new PublicKey(SPL_TOKEN_MINT_ADDRESS);

        console.log(`Using token mint: ${tokenMint.toBase58()}`);
        console.log(`Using Token-2022 Program ID: ${TOKEN_2022_PROGRAM_ID.toBase58()}`);

        const associatedTokenAddress = getAssociatedTokenAddressSync(
            tokenMint,
            owner,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        console.log(`Derived ATA: ${associatedTokenAddress.toBase58()}`);

        let balance = 0;
        let tokenAccountExists = false;

        try {
            const tokenAccount = await getAccount(
                connection,
                associatedTokenAddress,
                'confirmed',
                TOKEN_2022_PROGRAM_ID
            );

            balance = Number(tokenAccount.amount) / Math.pow(10, 6);
            tokenAccountExists = true;

            console.log(`Token account found: ${associatedTokenAddress.toBase58()}`);
            console.log(`Balance: ${balance} ES`);
            console.log(`Token account data:`, {
                mint: tokenAccount.mint.toBase58(),
                owner: tokenAccount.owner.toBase58(),
                amount: tokenAccount.amount.toString(),
                delegate: tokenAccount.delegate?.toBase58() || null,
                state: tokenAccount.state,
                isNative: tokenAccount.isNative?.toString() || null,
                delegatedAmount: tokenAccount.delegatedAmount.toString(),
                closeAuthority: tokenAccount.closeAuthority?.toBase58() || null
            });

        } catch (error) {
            if (error.name === 'TokenAccountNotFoundError') {
                console.log(`Token account not found for ${address}, balance is 0`);
                balance = 0;
            } else {
                console.error(`Error getting token account for ${address}:`, error);
                throw error;
            }
        }

        const previousAccounts = knownTokenAccounts.get(address) || new Set();
        if (tokenAccountExists && !previousAccounts.has(associatedTokenAddress.toBase58())) {
            console.log(`New token account detected for ${address}: ${associatedTokenAddress.toBase58()}`);
            if (chatId) {
                await bot.telegram.sendMessage(chatId, `New token account created for ${address}: ${associatedTokenAddress.toBase58()}`);
            }
        }

        return {
            balance,
            tokenAccount: tokenAccountExists ? associatedTokenAddress.toBase58() : null
        };

    } catch (error) {
        console.error(`Error getting token balance for ${address}:`, error);
        return { balance: null, tokenAccount: null };
    }
}

async function monitorBalances() {
    console.log('Starting balance monitoring cycle');
    for (const [chatId, addresses] of userAddresses.entries()) {
        console.log(`Checking addresses for chat ID: ${chatId}`);
        for (const address of addresses) {
            console.log(`Monitoring balance for address: ${address}`);
            const { balance: currentBalance, tokenAccount } = await getTokenBalance(address, chatId);

            if (currentBalance === null) {
                console.log(`Skipping address ${address} due to balance fetch error`);
                continue;
            }

            if (tokenAccount) {
                knownTokenAccounts.set(address, new Set([tokenAccount]));
            }

            const lastBalance = lastBalances.get(address) || 0;

            if (currentBalance !== lastBalance) {
                const change = currentBalance - lastBalance;
                const message = `Balance change detected for ${address}:\n` +
                    `Previous: ${lastBalance} ES\n` +
                    `Current: ${currentBalance} ES\n` +
                    `Change: ${change > 0 ? '+' : ''}${change} ES`;
                console.log(`Sending balance change notification for ${address} to chat ID: ${chatId}`);
                await bot.telegram.sendMessage(chatId, message);
                lastBalances.set(address, currentBalance);
                console.log(`Updated last balance for ${address} to: ${currentBalance}`);
            } else {
                console.log(`No balance change for ${address}`);
            }
        }
    }
    console.log('Completed balance monitoring cycle');
}

async function main() {
    console.log('Starting bot initialization');
    for (const address of ADDRESSES_TO_CHECK) {
        try {
            console.log(`Validating initial address: ${address}`);
            new PublicKey(address);
            const { balance, tokenAccount } = await getTokenBalance(address, null);
            lastBalances.set(address, balance);
            if (tokenAccount) {
                knownTokenAccounts.set(address, new Set([tokenAccount]));
            }
            console.log(`Set initial balance for ${address}: ${balance} ES`);
            console.log(`Set initial token account for ${address}: ${tokenAccount}`);
        } catch (error) {
            console.error(`Error loading initial address: ${address}, error:`, error);
        }
    }

    setInterval(monitorBalances, 10000);
    console.log('Started balance monitoring interval');

    bot.launch();
    console.log('Bot launched successfully');
}

bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx.updateType}:`, err);
});

process.once('SIGINT', () => {
    console.log('Received SIGINT, stopping bot');
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    console.log('Received SIGTERM, stopping bot');
    bot.stop('SIGTERM');
});

main().catch((error) => {
    console.error('Main function error:', error);
});