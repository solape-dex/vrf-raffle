
use switchboard_v2::VrfAccountData;
use spl_associated_token_account::*;
use anchor_lang::prelude::*;
use anchor_spl::token::*;
use std::mem::size_of;

declare_id!("4iMPsUWtpnNQhjhs1gSw74j5arJpxXa6DrUWYKXsgWVn");

const NULL_KEY_ARRAY: [u8; 32] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];

const MAX_RAFFLE_LENGTH: u64 = 94670856; // 3 Years
const NOT_REDEEMED_LENGTH: u64 = 15778476; // 6 Months
const MAX_MASTER_RAFFLE_INDEXES: u16 = 5000; // Too many will overflow the stack
const MAX_NAME_LENGTH: usize = 63; 
const STATE_SEED: &[u8] = b"SOLAPE";

#[program]
pub mod raffle {
    use super::*;

    // ------------ CREATE MASTER RAFFLE -------------------------------
    pub fn create_master_raffle(
        ctx: Context<CreateMasterRaffle>,
        params: CreateMasterRaffleParams,
    ) -> ProgramResult {

        let master_raffle = &mut ctx.accounts.master_raffle;

        // Simple Checks
        if params.name.len() > MAX_NAME_LENGTH { return Err(ErrorCode::NameTooLong.into()); }
        if params.bot_name.len() > MAX_NAME_LENGTH { return Err(ErrorCode::NameTooLong.into()); }
        if params.max_raffles < 1 { return Err(ErrorCode::NeedRaffle.into()); }
        if params.max_raffles > MAX_MASTER_RAFFLE_INDEXES { return Err(ErrorCode::TooManyRaffles.into()); }

        // Check RNG
        let vrf_account_info = &ctx.accounts.vrf_account;
        let _vrf = VrfAccountData::new(vrf_account_info)
            .map_err(|_| ProgramError::from(ErrorCode::BadVRF))?;

        // Authorities
        master_raffle.name = String::from(params.name);
        master_raffle.master_raffle = master_raffle.key();
        master_raffle.owner = ctx.accounts.owner.key();

        // Limits
        master_raffle.max_raffles = params.max_raffles;

        // RNG
        master_raffle.oracle = ctx.accounts.oracle.key.clone();
        master_raffle.vrf_account = ctx.accounts.vrf_account.key.clone();
        master_raffle.rng_bot = ctx.accounts.rng_bot.key();

        // Bot
        let bot = &mut ctx.accounts.rng_bot.load_init()?;

        let bot_name_bytes = params.bot_name.as_bytes();
        for i in 0..bot_name_bytes.len() {
            bot.name[i] = bot_name_bytes[i];
        }
        bot.name[MAX_NAME_LENGTH - 1] = 0; //Null Terminate

        bot.authority = ctx.accounts.owner.key();
        bot.vrf_account = ctx.accounts.vrf_account.key();
        bot.rng_uses_left = 0;
        bot.last_timestamp = 0;

        Ok(())
    }

    // ------------ REMOVE FROM MASTER RAFFLE -------------------------------
    pub fn remove_raffles_from_master(
        ctx: Context<RemoveRafflesFromMaster>,
        params: RemoveRafflesFromMasterParams,
    ) -> ProgramResult {

        let master_raffle = &mut ctx.accounts.master_raffle;

        // No real checks needed, removing a raffle from the master
        // does not actually delete the raffle and it can be retrevied

        for raffle in params.raffles_to_remove {
            let mut index = master_raffle.raffles.len();
            for i in 0..master_raffle.raffles.len() {
                if master_raffle.raffles[i] == raffle {
                    index = i;
                    break;
                }
            }   
            if index != master_raffle.raffles.len() {
                master_raffle.raffles.remove(index);
            }
        }

        Ok(())
    }

    // ------------ UPDATE MASTER RNG -------------------------------
    pub fn update_master_rng(
        ctx: Context<UpdateMasterRng>,
    ) -> ProgramResult {

        let master_raffle = &mut ctx.accounts.master_raffle;

        master_raffle.vrf_account = ctx.accounts.new_vrf_account.key();
        master_raffle.oracle = ctx.accounts.new_oracle_account.key();

        // Bot
        let bot = &mut ctx.accounts.rng_bot.load_init()?;

        for i in 0..32 {
            bot.rng_buffer[i] = 0;
        }

        bot.vrf_account = ctx.accounts.new_vrf_account.key();
        bot.rng_uses_left = 0;
        bot.last_timestamp = 0;

        Ok(())
    }


    // ------------ CREATE RAFFLE -------------------------------
    pub fn create_raffle(
        ctx: Context<CreateRaffle>,
        params: CreateRaffleParams,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;
        let master_raffle = &mut ctx.accounts.master_raffle;
        let bot = &mut ctx.accounts.rng_bot.load_mut()?;

        // Simple Checks
        if params.name.len() > MAX_NAME_LENGTH { return Err(ErrorCode::NameTooLong.into()); }
        if params.payment_option_count < 1 { return Err(ErrorCode::GeneralError.into()); }
        if params.reward_count < 1 { return Err(ErrorCode::NeedReward.into()); }
        if params.max_holder_count < 1 { return Err(ErrorCode::NeedHolders.into()); }
        if master_raffle.raffles.len() + 1 > master_raffle.max_raffles as usize { return Err(ErrorCode::TooManyRaffles.into()); }
        if bot.request_counter < 1 { return Err(ErrorCode::NeedRngFirst.into()); }

        // Check Gatekeeper
        let gatekeeper = Pubkey::create_program_address(
            &[raffle.to_account_info().key.as_ref(), &[params.nonce]],
            ctx.program_id,
        )
        .map_err(|_| ErrorCode::BadGatekeeperNonce)?;

        if &gatekeeper != ctx.accounts.gatekeeper.to_account_info().key {
            return Err(ErrorCode::BadGatekeeperNonce.into());
        }

        // Authorities
        raffle.name = String::from(params.name);
        raffle.raffle = raffle.key();
        raffle.master_raffle = master_raffle.key();
        raffle.owner = ctx.accounts.owner.key();
        raffle.gatekeeper = ctx.accounts.gatekeeper.key();
        raffle.nonce = params.nonce;

        // Limits
        raffle.max_tickets_per_holder = params.max_tickets_per_holder;
        raffle.payment_option_count = params.payment_option_count;
        raffle.reward_count =params.reward_count;
        raffle.max_holder_count = params.max_holder_count;

        // Rules
        raffle.start_date = 0;
        raffle.end_date = !0;

        // RNG
        raffle.rng_bot = master_raffle.rng_bot.key();

        // Master Raffle
        master_raffle.raffles.push(raffle.key());

        Ok(())
    }

    // ------------ LOAD PAYMENT OPTION -------------------------------
    pub fn load_payment_option(
        ctx: Context<LoadPaymentOption>,
        params: LoadPaymentOptionParams,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;

        if params.name.len() > MAX_NAME_LENGTH { return Err(ErrorCode::NameTooLong.into()); }
        if params.tickets_per_payment > raffle.max_tickets_per_holder { return Err(ErrorCode::TooManyTicketsPerPayment.into()); }
        if params.payment_amount < 1  { return Err(ErrorCode::NeedPaymentAmount.into()); }
        if params.tickets_per_payment < 1  { return Err(ErrorCode::NeedTicketsPerPayemnt.into()); }
        if raffle.start_date != 0  { return Err(ErrorCode::RaffleStarted.into()); }
        if raffle.payment_option_count < (raffle.payment_options.len() + 1) as u8 { return Err(ErrorCode::TooManyPaymentOptions.into()); }

        raffle.payment_options.push(
            TicketPaymentOption{
                name: String::from(params.name),
                payment_mint: ctx.accounts.payment_vault.mint,
                payment_amount: params.payment_amount,
                tickets_per_payment: params.tickets_per_payment,
                payment_tally: 0,
                cashed_out: false,
            }
        );

        Ok(())
    }

    // ------------ LOAD REWARD -------------------------------
    pub fn load_reward(
        ctx: Context<LoadReward>,
        params: LoadRewardParams,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;

        if params.name.len() > MAX_NAME_LENGTH { return Err(ErrorCode::NameTooLong.into()); }
        if raffle.start_date != 0  { return Err(ErrorCode::RaffleStarted.into()); }
        if params.reward_amount < 1  { return Err(ErrorCode::NeedRewardAmount.into()); }
        if params.reward_amount > ctx.accounts.owner_vault.amount { return Err(ErrorCode::BadOwnerRewardBalance.into()); }
        if raffle.reward_count < (raffle.rewards.len() + 1) as u8 { return Err(ErrorCode::TooManyRewards.into()); }

        let cpi_accounts = Transfer {
            from: ctx.accounts.owner_vault.to_account_info().clone(),
            to: ctx.accounts.reward_vault.to_account_info().clone(),
            authority: ctx.accounts.owner.to_account_info().clone(),
        };
        let cpi_program = ctx.accounts.token_program.clone();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        let token_tx_result = transfer(cpi_ctx, params.reward_amount);

        if !token_tx_result.is_ok() {
            return Err(ErrorCode::CouldNotTX.into());
        }

        raffle.rewards.push(
            Reward{
                name: String::from(params.name),
                group_id: params.group_id.clone(),
                reward_amount: params.reward_amount,
                reward_mint: ctx.accounts.reward_vault.mint.key(),
                winner: Pubkey::new_from_array(NULL_KEY_ARRAY).clone(),
                reward_redeemed: false,
            }
        );

        Ok(())
    }

    // ------------ START RAFFLE -------------------------------
    pub fn start_raffle(
        ctx: Context<StartRaffle>,
        params: StartRaffleParams,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;
        let start_date = Clock::get()?.unix_timestamp as u64;

        // Simple Checkts
        if params.end_date <= start_date { return Err(ErrorCode::BadEndDate.into()); }
        if raffle.start_date != 0  { return Err(ErrorCode::RaffleStarted.into()); }
        if params.end_date > start_date + MAX_RAFFLE_LENGTH { return Err(ErrorCode::TooBigEndDate.into()); }
        if raffle.payment_options.len() < 1 { return Err(ErrorCode::NeedPaymentOption.into()); }
        if raffle.rewards.len() < 1 { return Err(ErrorCode::NeedReward.into()); }

        // Rules
        raffle.start_date = start_date;
        raffle.end_date = params.end_date;

        Ok(())
    }

    // ------------ RNG CB -------------------------------
    pub fn rng_callback(
        ctx: Context<RngCallback>,
    ) -> ProgramResult {

        let vrf_account_info = &ctx.accounts.vrf_account;
        let vrf = VrfAccountData::new(vrf_account_info)?;
        let result_buffer = vrf.get_result()?;

        let bot = &mut ctx.accounts.state.load_mut()?;
        let mut is_diffrent = false;

        if bot.vrf_account != vrf_account_info.key() { return Err(ErrorCode::BadRNG.into()); }
        if bot.authority != vrf.authority { return Err(ErrorCode::BadRNG.into()); }

        for i in 0..32 {
            if result_buffer[i] != bot.rng_buffer[i] {
                is_diffrent = true;
                break;
            }
        }

        if is_diffrent {
            bot.rng_uses_left = 8;
            bot.rng_buffer = result_buffer;
            bot.last_timestamp = Clock::get()?.unix_timestamp as u64;
            bot.request_counter += 1;
        } else { 
            return Err(ErrorCode::BadRNG.into()); 
        }

        Ok(())
    }

    // ------------ BUY TICKETS --------------------------------
    pub fn buy_tickets(
        ctx: Context<BuyTickets>,
        params: BuyTicketsParam
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;

        // Simple Checks
        if params.payment_option_index as usize >= raffle.payment_options.len() { return Err(ErrorCode::BadPaymentIndex.into()); }
        if raffle.start_date == 0 { return Err(ErrorCode::RaffleNotStarted.into()); }
        if Clock::get()?.unix_timestamp as u64 > raffle.end_date { return Err(ErrorCode::RaffleEnded.into()); }
        if ctx.accounts.holder.key == &raffle.owner { return Err(ErrorCode::BadBuyer.into()); }

        let payment_option = raffle.payment_options[params.payment_option_index as usize].clone();
        let mut holder_index = raffle.holders.len();

        // Check for existing holder
        for i in 0..raffle.holders.len() {
            if &raffle.holders[i].holder == ctx.accounts.holder.key {
                holder_index = i;
                break;
            }
        }

        // Payment Checks
        if payment_option.payment_mint != ctx.accounts.holder_vault.mint { return Err(ErrorCode::BadPaymentMint.into()); }
        if payment_option.payment_amount > ctx.accounts.holder_vault.amount { return Err(ErrorCode::NotEnoughToBuy.into()); }

        // Last Checks
        if holder_index == raffle.holders.len() { // Is not in holders
            if raffle.holders.len() + 1 > raffle.max_holder_count as usize { return Err(ErrorCode::TooManyHolders.into()); }
        } else {
            // Need to avoid overflows
            if (raffle.holders[holder_index].tickets as u16 + payment_option.tickets_per_payment as u16) > raffle.max_tickets_per_holder as u16 { 
                return Err(ErrorCode::BuyingTooMany.into()); 
            }
        }

        // Grab Payment
        let cpi_program = ctx.accounts.token_program.clone();
        let rx = Transfer {
            from: ctx.accounts.holder_vault.to_account_info().clone(),
            to: ctx.accounts.payment_vault.to_account_info().clone(),
            authority: ctx.accounts.holder.to_account_info().clone(),
        };
        let rx_cpi = CpiContext::new(cpi_program.clone(), rx);

        let rx_result = transfer(rx_cpi, payment_option.payment_amount);

        if !rx_result.is_ok() {
            return Err(ErrorCode::CouldNotTX.into());
        }

        // Set State
        if holder_index == raffle.holders.len() { // Is not in holders
            raffle.holders.push(
                TicketHolder{
                    holder: ctx.accounts.holder.key().clone(),
                    tickets: payment_option.tickets_per_payment,
                }
            );
        } else {
            raffle.holders[holder_index].tickets += payment_option.tickets_per_payment;
        }

        raffle.payment_options[params.payment_option_index as usize].payment_tally += 1;

        Ok(())
    }


    // ------------ PICK WINNER -------------------------------
    pub fn pick_winner(
        ctx: Context<PickWinner>,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;
        let bot = &mut ctx.accounts.rng_bot.load_mut()?;

        let mut reward_index = raffle.rewards.len();
        let null_winner = Pubkey::new_from_array(NULL_KEY_ARRAY).clone();

        for i in 0..raffle.rewards.len() {
            if raffle.rewards[i].winner == null_winner {
                reward_index = i;
                break;
            }
        }

        // Simple Checks
        if reward_index == raffle.rewards.len() { return Err(ErrorCode::NoMoreRewards.into()); }
        if Clock::get()?.unix_timestamp as u64 <= raffle.end_date { return Err(ErrorCode::RaffleNotEnded.into()); }
        if raffle.end_date > bot.last_timestamp { return Err(ErrorCode::StaleRNG.into()); }

        let winner_index = get_winner_index(
            bot.rng_uses_left,
            &bot.rng_buffer,
            &raffle.holders,
        );

        let mut winner = raffle.owner;

        if winner_index == !0 {
            return Err(ErrorCode::NoMoreRNG.into());
        } else if winner_index != raffle.holders.len() {

            bot.rng_uses_left -= 1;
            raffle.holders[winner_index].tickets -= 1;
            winner = raffle.holders[winner_index].holder;

        }

        let reward_group_id = raffle.rewards[reward_index].group_id.clone();
        if reward_group_id != Pubkey::new_from_array(NULL_KEY_ARRAY).clone() {
            for i in 0..raffle.rewards.len() {
                if reward_group_id == raffle.rewards[i].group_id {
                    raffle.rewards[i].winner = winner;
                }
            }
        } else {
            raffle.rewards[reward_index].winner = winner;
        }

        Ok(())
    }

    // ------------ CASH OUT OWNER -------------------------------
    pub fn cash_out_owner(
        ctx: Context<CashOutOwner>,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;

        if Clock::get()?.unix_timestamp as u64 <= raffle.end_date { return Err(ErrorCode::RaffleNotEnded.into()); }
        if ctx.accounts.payment_vault.amount == 0 { return Err(ErrorCode::NoMoreSPL.into()); }

        // Tally up the amount to TX
        let mut amount = 0 as u64;
        for i in 0..raffle.payment_options.len() {
            if raffle.payment_options[i].payment_mint == ctx.accounts.payment_vault.mint {
                amount += raffle.payment_options[i].payment_tally * raffle.payment_options[i].payment_amount;
            }
        }

        // TX Output
        let seeds = &[
            raffle.to_account_info().key.as_ref(),
            &[raffle.nonce],
        ];
        let signer = &[&seeds[..]];
        let cpi_program = ctx.accounts.token_program.clone();

        let output_tx = Transfer {
            from: ctx.accounts.payment_vault.to_account_info().clone(),
            to: ctx.accounts.owner_vault.to_account_info().clone(),
            authority: ctx.accounts.gatekeeper.clone(),
        };
        let output_cpi = CpiContext::new_with_signer(cpi_program.clone(), output_tx, signer);
        let output_tx_result = transfer(output_cpi, amount as u64);

        if !output_tx_result.is_ok() {
            return Err(ErrorCode::CouldNotTX.into());
        }

        // Mark as cashed out
        for i in 0..raffle.payment_options.len() {
            if raffle.payment_options[i].payment_mint == ctx.accounts.payment_vault.mint {
                raffle.payment_options[i].cashed_out = true;
            }
        }

        Ok(())
    }

    // ------------ REDEEM REWARD -------------------------------
    pub fn redeem_reward(
        ctx: Context<RedeemReward>,
    ) -> ProgramResult {

        let raffle = &mut ctx.accounts.raffle;
        let winner = ctx.accounts.winner.key();
        let current_time = Clock::get()?.unix_timestamp as u64;
        let past_redeem_threshold = current_time > raffle.end_date + NOT_REDEEMED_LENGTH && raffle.owner == winner;
        let mut index = raffle.rewards.len();

        for i in 0..raffle.rewards.len() {
            if raffle.rewards[i].winner == winner || past_redeem_threshold {
                if !raffle.rewards[i].reward_redeemed {
                    index = i;
                    break;
                }
            }
        }

        // Simple Checks
        if index == raffle.rewards.len() { return Err(ErrorCode::NoWinnerLeft.into()); }
        if current_time <= raffle.end_date { return Err(ErrorCode::RaffleNotEnded.into()); }
        if winner == Pubkey::new_from_array(NULL_KEY_ARRAY).clone() { return Err(ErrorCode::BadWinner.into()); }
        if raffle.rewards[index].reward_mint != ctx.accounts.winner_vault.mint { return Err(ErrorCode::BadWinnerVault.into()); }

        // TX Output
        let seeds = &[
            raffle.to_account_info().key.as_ref(),
            &[raffle.nonce],
        ];
        let signer = &[&seeds[..]];
        let cpi_program = ctx.accounts.token_program.clone();

        let output_tx = Transfer {
            from: ctx.accounts.reward_vault.to_account_info().clone(),
            to: ctx.accounts.winner_vault.to_account_info().clone(),
            authority: ctx.accounts.gatekeeper.clone(),
        };
        let output_cpi = CpiContext::new_with_signer(cpi_program.clone(), output_tx, signer);
        let output_tx_result = transfer(output_cpi, raffle.rewards[index].reward_amount as u64);

        if !output_tx_result.is_ok() {
            return Err(ErrorCode::CouldNotTX.into());
        }

        raffle.rewards[index].reward_redeemed = true;

        Ok(())
    }
}

// ------------ CREATE MASTER RAFFLE ------------------------
#[derive(Accounts)]
#[instruction(params: CreateMasterRaffleParams)]
pub struct CreateMasterRaffle<'info> {
    #[account(zero)]
    pub master_raffle: Account<'info, MasterRaffle>, // Account data

    // RNG
    pub oracle: AccountInfo<'info>, // Account that makes the RNG
    pub vrf_account: AccountInfo<'info>, // Account that actually requests the RNG
    #[account(
        init,
        seeds = [
            STATE_SEED, 
            master_raffle.key().as_ref(), 
            owner.key().as_ref()
        ],
        payer = owner,
        bump = params.bot_bump,
    )]
    pub rng_bot: AccountLoader<'info, RngBot>, // Account that holds the RNG for all child raffles

    // Signers
    #[account(mut)]
    pub owner: Signer<'info>, // Owner needs to pay for the account creation
    #[account(address = solana_program::system_program::ID)]
    pub system_program: AccountInfo<'info>, // Needed for account creation
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct CreateMasterRaffleParams {
    pub name: String, // Somthing human readable to call the master
    pub max_raffles: u16, // Maxiumum amount of raffles this can hold
    pub bot_bump: u8, // Bot bump
    pub bot_name: String, // Name to call the RNG bot
}

// ------------ REMOVE RAFFLES FROM MASTER -------------------------------
#[derive(Accounts)]
pub struct RemoveRafflesFromMaster<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = master_raffle.owner == owner.key()
    )]
    pub master_raffle: Account<'info, MasterRaffle>, // Accound data

    #[account(mut)]
    pub owner: Signer<'info>, // Only the owner should be able to remove keys from the Master Raffle
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct RemoveRafflesFromMasterParams {
    pub raffles_to_remove: Vec<Pubkey>, // The pubkey of raffles to remove - if one is removed accidentally, it can be retrieved.
}

// ------------ UPDATE MASTER VRF -------------------------------
#[derive(Accounts)]
pub struct UpdateMasterRng<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = master_raffle.owner == owner.key()
    )]
    pub master_raffle: Account<'info, MasterRaffle>, // Accound data
    #[account(
        mut,
        constraint = rng_bot.key() == master_raffle.rng_bot
    )]
    pub rng_bot: AccountLoader<'info, RngBot>, // Must check RNG bot

    pub new_oracle_account: AccountInfo<'info>, // Account that makes the RNG
    pub new_vrf_account: AccountInfo<'info>, // Account that actually requests the RNG

    #[account(mut)]
    pub owner: Signer<'info>, // Only the owner should be able to remove keys from the Master Raffle
}

// ------------ CREATE RAFFLE -------------------------------
#[derive(Accounts)]
#[instruction(params: CreateRaffleParams)]
pub struct CreateRaffle<'info> {
    #[account(zero)]
    pub raffle: Account<'info, Raffle>, // Account data to be created
    pub gatekeeper: AccountInfo<'info>, // Needed to sign for and own all of the SPL vaults

    #[account(
        mut, 
        has_one = owner, 
    )]
    pub master_raffle: Account<'info, MasterRaffle>, // Parent raffle that holds this as an index as well as has access to the RNG
    #[account(
        mut,
        constraint = rng_bot.key() == master_raffle.rng_bot
    )]
    pub rng_bot: AccountLoader<'info, RngBot>, // Must check RNG bot

    // Signers
    #[account(mut)]
    pub owner: Signer<'info>, // Owner pays for the account creation   
    #[account(address = solana_program::system_program::ID)]
    pub system_program: AccountInfo<'info>, // Needed for the account creation
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct CreateRaffleParams {
    pub nonce: u8, // Nonce for the gatekeeper
    pub name: String, // Something human readable to call the raffle
    pub max_tickets_per_holder: u8, // Each holder can only have up to 255 tickets per raffle
    pub payment_option_count: u8, // Amount of payment options to load
    pub reward_count: u8, // Amount of reward types to load
    pub max_holder_count: u16, // Max amount of holder per raffle 
}

// ------------ LOAD PAYMENT OPTION -------------------------------
#[derive(Accounts)]
pub struct LoadPaymentOption<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Account data

    #[account(
        seeds = [raffle.to_account_info().key.as_ref()],
        bump = raffle.nonce,
    )]
    gatekeeper: AccountInfo<'info>, // Used as a check

    #[account(
        mut, 
        constraint = gatekeeper.key == &payment_vault.owner 
        && get_associated_token_address(&gatekeeper.key(), &payment_vault.mint) == payment_vault.key()
    )]
    pub payment_vault: Account<'info, TokenAccount>, // SPL vault that will keep the payment SPLs

    // Signers
    #[account(mut)]
    pub owner: Signer<'info>, // Only the owner should be able to load a payment option
    pub token_program: AccountInfo<'info>, // Needed to TX SPLs
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LoadPaymentOptionParams {
    pub name: String, // Somthing human readable for the front end
    pub payment_amount: u64, // Amount of the SLP for this payment option
    pub tickets_per_payment: u8, // Number of tickets per purchase with this option
}

// ------------ LOAD REWARD -------------------------------
#[derive(Accounts)]
pub struct LoadReward<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Account data

    #[account(
        seeds = [raffle.to_account_info().key.as_ref()],
        bump = raffle.nonce,
    )]
    gatekeeper: AccountInfo<'info>, // Used as a check

    #[account(
        mut, 
        constraint = gatekeeper.key == &reward_vault.owner 
        && get_associated_token_address(&gatekeeper.key(), &reward_vault.mint) == reward_vault.key()
    )]
    pub reward_vault: Account<'info, TokenAccount>, // SPL vault owned by the gatekeeper

    #[account(
        mut, 
        constraint = owner.key == &owner_vault.owner 
        && owner_vault.mint == reward_vault.mint
        && get_associated_token_address(&owner.key(), &reward_vault.mint) == owner_vault.key()
    )]
    pub owner_vault: Account<'info, TokenAccount>, // SPL vault of owner -> gatekeeper's vault

    // Signers
    #[account(mut)]
    pub owner: Signer<'info>, // Only the owner should be able to load a reward
    pub token_program: AccountInfo<'info>, // Needed for TX 
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LoadRewardParams {
    pub name: String, // Something human readable for the frontend to show
    pub group_id: Pubkey, // All other Rewards with the same ID will be treated as one large reward, pass in a unique key or a zero'd key to let it be on it's own
    pub reward_amount: u64, // How many of the SPL is awarded (for an NFT this would be 1)
}


// ------------ START RAFFLE -------------------------------
#[derive(Accounts)]
pub struct StartRaffle<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Account data

 
    #[account(mut)]
    pub owner: Signer<'info>, // Only the owner should be able to start this
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct StartRaffleParams {
    pub end_date: u64, // Unix time, needs to be larger that the Unix date when StartRaffle is called
}

// ------------ BUY TICKET -------------------------------
#[derive(Accounts)]
pub struct BuyTickets<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Account data

    #[account(
        seeds = [raffle.to_account_info().key.as_ref()],
        bump = raffle.nonce,
    )]
    gatekeeper: AccountInfo<'info>, // Here to check

    #[account(
        mut, 
        constraint = gatekeeper.key == &payment_vault.owner 
        && get_associated_token_address(&gatekeeper.key(), &payment_vault.mint) == payment_vault.key()
    )]
    pub payment_vault: Account<'info, TokenAccount>, // Vault owned by the gatekeeper to store the token

    #[account(
        mut, 
        constraint = holder.key == &holder_vault.owner 
        && get_associated_token_address(&holder.key(), &holder_vault.mint) == holder_vault.key()
        && holder_vault.mint == payment_vault.mint
    )]
    pub holder_vault: Account<'info, TokenAccount>, // Holds the token to buy the ticket

    // Signers
    #[account(mut)]
    pub holder: Signer<'info>, // Person buying the tickets
    #[account(mut)]
    pub owner: AccountInfo<'info>, // Used as a check    
    pub token_program: AccountInfo<'info>, // Used to TX
}
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct BuyTicketsParam {
    pub payment_option_index: u8, // Index of the payment option used
}

// ------------ RNG CB ---------------------------
#[derive(Accounts)]
pub struct RngCallback<'info> {
    #[account(mut)]
    pub state: AccountLoader<'info, RngBot>, // The account to transfer the new RNG to
    pub vrf_account: AccountInfo<'info>, // Account with new RNG from Switchboard
}

// ------------ PICK WINNER ---------------------------
#[derive(Accounts)]
pub struct PickWinner<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Account data

    #[account(
        mut, 
        constraint = rng_bot.key() == raffle.rng_bot,
    )]
    pub rng_bot: AccountLoader<'info, RngBot>, // Holdes the RNG value

    #[account(mut)]
    pub owner: AccountInfo<'info>, // No need for this to be signed, anyone could call it
}

// ------------ CASH OUT OWNER ---------------------------
#[derive(Accounts)]
pub struct CashOutOwner<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Account data

    #[account(
        seeds = [raffle.to_account_info().key.as_ref()],
        bump = raffle.nonce,
    )]
    gatekeeper: AccountInfo<'info>, // Owner of the payment vault needed to sign the TX

    #[account(
        mut, 
        constraint = gatekeeper.key == &payment_vault.owner 
        && get_associated_token_address(&gatekeeper.key(), &payment_vault.mint) == payment_vault.key()
    )]
    pub payment_vault: Account<'info, TokenAccount>, // SPL vault users paid into, owned by the gatekeeper

    #[account(
        mut, 
        constraint = owner.key == &owner_vault.owner 
        && owner_vault.mint == payment_vault.mint
        && get_associated_token_address(&owner.key(), &payment_vault.mint) == owner_vault.key()
    )]
    pub owner_vault: Account<'info, TokenAccount>, // SPL vault owned by owner

    // Signers
    #[account(mut)]
    pub owner: Signer<'info>, // Needs to sign
    pub token_program: AccountInfo<'info>, // Used to TX
}

// ------------ REDEEM REWARD -------------------------
#[derive(Accounts)]
pub struct RedeemReward<'info> {
    #[account(
        mut, 
        has_one = owner, 
        constraint = raffle.owner == owner.key()
    )]
    pub raffle: Account<'info, Raffle>, // Has the data

    #[account(
        seeds = [raffle.to_account_info().key.as_ref()],
        bump = raffle.nonce,
    )]
    gatekeeper: AccountInfo<'info>, // Needs to sign the TX

    #[account(
        mut, 
        constraint = gatekeeper.key == &reward_vault.owner 
        && get_associated_token_address(&gatekeeper.key(), &reward_vault.mint) == reward_vault.key()
    )]
    pub reward_vault: Account<'info, TokenAccount>, // SPL vault owned by the gatekeeper

    #[account(
        mut, 
        constraint = winner.key == &winner_vault.owner 
        && winner_vault.mint == reward_vault.mint
        && get_associated_token_address(&winner.key(), &winner_vault.mint) == winner_vault.key()
    )]
    pub winner_vault: Account<'info, TokenAccount>, // SPL vault owned by the winner

    // Signers
    #[account(mut)]
    pub winner: Signer<'info>, // Needs to sign to redeem
    pub owner: AccountInfo<'info>, // Used for a check
    pub token_program: AccountInfo<'info>, // Used to TX
}

// ------------ STRUCTS -------------------------------
#[account]
pub struct MasterRaffle {
    // Authorities
    pub name: String, //Something human readable
    pub master_raffle: Pubkey, //Self Pointer, easier to call on the frontend
    pub owner: Pubkey, //Owner of the raffle who has the authority to call all functions

    // RNG
    pub oracle: Pubkey, //The thing that cranks out our RNG
    pub vrf_account: Pubkey, //Switchboard account for raffle draw
    pub rng_bot: Pubkey, //The RNG structure

    // Indexs
    pub max_raffles: u16, //How many raffles this can index
    pub raffles: Vec<Pubkey>, //Index of raffles
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct TicketPaymentOption {
    pub name: String, //Something human readable
    pub payment_mint: Pubkey, //The mint of the SPL used to purchase 'tickets_per_payment' tickets
    pub payment_amount: u64, //The amount of the SPL token needed to purchase 'tickets_per_payment' tickets
    pub tickets_per_payment: u8, //The amount of tickets given to the purchaser
    pub payment_tally: u64, //How many times this payment option was executed
    pub cashed_out: bool, //Marked when the vault is cleared
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct Reward {
    pub name: String, //Something human readable
    pub reward_mint: Pubkey, //The SPL token vault, owned by the gatekeeper, to hold the assets until redeemed
    pub group_id: Pubkey, //All rewards with the same pubkey will treated as one
    pub reward_amount: u64, //The amount from the vault to give to the winner

    pub winner: Pubkey, //The pubkey of the winner, once this is set, they can redeem what's in the vault * reward_amount
    pub reward_redeemed: bool, //When the winner redeems their prize, this will be set
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct TicketHolder {
    pub holder: Pubkey, //The pubkey of the holder
    pub tickets: u8, //How many tickets this holder has
}

#[account]
pub struct Raffle {
    // Authorities
    pub name: String, //Something human readable
    pub master_raffle: Pubkey, //Parent master raffle
    pub raffle: Pubkey, //Self Pointer, easier to call on the frontend
    pub owner: Pubkey, //Owner of the raffle who has the authority to call all functions
    pub gatekeeper: Pubkey, //PDA that signs for the transactions
    pub nonce: u8, //PDA nonce

    // Limits
    pub max_tickets_per_holder: u8, //Used to make the raffle a little more fair
    pub payment_option_count: u8, //Used to size the account correctly
    pub reward_count: u8, //Used to size the account correctly
    pub max_holder_count: u16, //Used to size the account correctly

    // Rules
    pub start_date: u64, //When the Raffle starts (In Unix Time)
    pub end_date: u64, //When the Raffle ends (In Unix Time)

    // RNG Bot
    pub rng_bot: Pubkey, //RNG bot from the master raffle that created it

    // Buying a Ticket
    pub payment_options: Vec<TicketPaymentOption>, //Ways people can purchase Tickets

    // Prizes
    pub rewards: Vec<Reward>, //Prizes people can redeem

    // Holders
    pub holders: Vec<TicketHolder>, //Everyone who buys a ticket
}

#[account(zero_copy)]
pub struct RngBot {
    pub authority: Pubkey,
    pub vrf_account: Pubkey,
    pub name: [u8; 64],
    pub last_timestamp: u64,
    pub request_counter: u64,
    pub rng_buffer: [u8; 32],
    pub rng_uses_left: u8,
}
impl Default for RngBot {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

pub fn get_master_raffle_size(
    params: CreateMasterRaffleParams,
) -> usize {
    return 
        8 // Program Discrimator
        + size_of::<MasterRaffle>()
        + size_of::<Pubkey>() * params.max_raffles as usize
        + (MAX_NAME_LENGTH + 1);
}

pub fn get_raffle_size(
    params: CreateRaffleParams,
) -> usize {
    return 
        8 // Program Discrimator
        + size_of::<Raffle>()
        + size_of::<TicketPaymentOption>() * params.payment_option_count as usize
        + size_of::<Reward>() * params.reward_count as usize
        + size_of::<TicketHolder>() * params.max_holder_count as usize
        + (MAX_NAME_LENGTH + 1) * (1 + params.payment_option_count as usize + params.reward_count as usize);
}

// ERROR CODES
#[error]
pub enum ErrorCode {
    // Generic
    #[msg("General Error")]
    GeneralError,
    #[msg("Name too long, max 63 chars")]
    NameTooLong,
    #[msg("Raffle has started")]
    RaffleStarted,
    #[msg("Raffle has not started")]
    RaffleNotStarted,
    #[msg("Raffle has ended")]
    RaffleEnded,
    #[msg("Raffle has not ended")]
    RaffleNotEnded,
    #[msg("Could not TX SPL")]
    CouldNotTX,

    // Create Master Raffle
    #[msg("Need at least 1 raffle")]
    NeedRaffle,
    #[msg("Too many raffles")]
    TooManyRaffles,
    #[msg("Bad VRF account")]
    BadVRF,


    // Create Raffle
    #[msg("Need at least 1 payment option")]
    NeedPaymentOption,
    #[msg("Need at least 1 reward")]
    NeedReward,
    #[msg("Need at least 1 holder")]
    NeedHolders,
    #[msg("Bad gatekeeper nonce")]
    BadGatekeeperNonce,
    #[msg("Need non-empty RNG")]
    NeedRngFirst,

    // Load Payment Option
    #[msg("Tickets per payment cannot be bigger than max tickets per holder")]
    TooManyTicketsPerPayment,
    #[msg("Tickets per payment amount needs to be more than 1")]
    NeedTicketsPerPayemnt,
    #[msg("Payment amount needs to be more than 1")]
    NeedPaymentAmount,
    #[msg("Too many payment options")]
    TooManyPaymentOptions,

    // Load Reward
    #[msg("Reward amount needs to be more than 1")]
    NeedRewardAmount,
    #[msg("Owner does not have enough of the reward")]
    BadOwnerRewardBalance,
    #[msg("Too many rewards")]
    TooManyRewards,

    // Start Raffle
    #[msg("End date needs to be larger than the current time")]
    BadEndDate,
    #[msg("End date can not be longer than 3 years")]
    TooBigEndDate,

    // RNG Callback
    #[msg("Bad RNG callback")]
    BadRNG,

    // Buy Tickets
    #[msg("Bad payment index")]
    BadPaymentIndex,
    #[msg("Owner cannot buy tickets")]
    BadBuyer,
    #[msg("Buying would cause a holder overflow")]
    TooManyHolders,
    #[msg("Payment mint does not match")]
    BadPaymentMint,
    #[msg("Not enough SPL to buy")]
    NotEnoughToBuy,
    #[msg("Buying would cause ticket overflow")]
    BuyingTooMany,

    // Pick Winner
    #[msg("No more rewards to pick")]
    NoMoreRewards,
    #[msg("Stale RNG, need to request more")]
    StaleRNG,
    #[msg("Not enough RNG, need to request more")]
    NoMoreRNG,

    // Cash out owner
    #[msg("No SPL in the payment vault")]
    NoMoreSPL,

    // Redeem Reward
    #[msg("No rewards left for this winner")]
    NoWinnerLeft,
    #[msg("Winner cannot be 0'd pubkey")]
    BadWinner,
    #[msg("Winner vault's mint does not match the reward mint")]
    BadWinnerVault,
}

pub fn get_winner_index(
    rng_uses_left: u8,
    rng_buffer: &[u8; 32],
    holders: &Vec<TicketHolder>,
) -> usize {

    let mut ticket_count = 0 as u32;
    for i in 0..holders.len() {
        ticket_count += holders[i].tickets as u32;
    }

    if ticket_count == 0 { return holders.len(); }
    if rng_uses_left == 0 { return !0; }

    let mut rng = 
        ((rng_buffer[(((rng_uses_left - 1) * 4) + 0) as usize] as u32) << 0)  | 
        ((rng_buffer[(((rng_uses_left - 1) * 4) + 1) as usize] as u32) << 8)  |
        ((rng_buffer[(((rng_uses_left - 1) * 4) + 2) as usize] as u32) << 16) |
        ((rng_buffer[(((rng_uses_left - 1) * 4) + 3) as usize] as u32) << 24);

    rng = rng % ticket_count;

    let mut winner_index = holders.len();
    for i in 0..holders.len() {
        if holders[i].tickets == 0 { continue; }
        let holder_tickets = holders[i].tickets as u32;

        if holder_tickets >= rng {
            winner_index = i;
            break;
        } else {
            rng -= holder_tickets;
        }
    }

    return winner_index;
}

// #[test]

#[test]
fn get_test_random_winner() {

    let mut holders: Vec<TicketHolder> = Vec::new();

    for _i in 0..20 {
        holders.push(
            TicketHolder {
                holder: Pubkey::new_unique(),
                tickets: 1,
            }
        );
    }

    holders.push(
        TicketHolder {
            holder: Pubkey::new_unique(),
            tickets: 5,
        }
    );

    let mut rng_uses_left = 8;

    let rng_buffer: [u8; 32] = [58, 215, 26, 110, 246, 41, 248, 198, 74, 83, 230, 131, 137, 31, 245, 244, 24, 32, 15, 228, 87, 224, 214, 182, 159, 222, 243, 40, 184, 156, 86, 125];

    for _i in 0..9 {
        eprintln!("\nRunning Index: {:?}", rng_uses_left);
        let index = get_winner_index(
            rng_uses_left,
            &rng_buffer,
            &holders,
        );
        if index != holders.len() && index != !0 {
            holders[index].tickets -= 1;
        }
        if rng_uses_left > 0 {
            rng_uses_left -= 1;
        }
        eprintln!("Response: {:?}\n", index);
    }
}



