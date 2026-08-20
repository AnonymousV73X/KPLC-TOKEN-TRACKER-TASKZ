"""Telegram bot: minimal /start handler for account linking.

This module provides a standalone bot that handles ONLY the /start <link_token> command
for associating a Telegram chat_id with a TASKZ user account. All other logic lives
in the web app. The bot does NOT process any other commands.

The bot runs as a separate process or can be started alongside FastAPI.
For single-process deployment, we use a lightweight approach: start the bot's
polling in a background task during FastAPI startup.
"""

import asyncio
import logging
from typing import Optional

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from app.config import get_settings
from app.database import async_session_factory
from app.services.notification import consume_link_token

logger = logging.getLogger(__name__)
settings = get_settings()
_bot_app: Optional[Application] = None


async def _start_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Handle /start <link_token> — associate this chat with a user account.
    """
    if not context.args or len(context.args) != 1:
        await update.message.reply_text(
            "Welcome to TASKZ. To link your account, use the link provided in the TASKZ web app settings."
        )
        return

    link_token = context.args[0].strip()
    chat_id = update.effective_chat.id

    async with async_session_factory() as db:
        try:
            user_id = await consume_link_token(link_token, chat_id, db)
            if user_id:
                await db.commit()
                await update.message.reply_text(
                    "\u2705 Your Telegram account has been linked to TASKZ. "
                    "You will receive alerts here when your units are running low."
                )
                logger.info("Telegram linked: chat_id=%d -> user_id=%d", chat_id, user_id)
            else:
                await db.rollback()
                await update.message.reply_text(
                    "\u274c Invalid or expired link token. Please generate a new one from the TASKZ settings page."
                )
        except Exception as e:
            await db.rollback()
            logger.error("Telegram link error: %s", e, exc_info=True)
            await update.message.reply_text(
                "An error occurred. Please try again later."
            )


def create_bot_app() -> Optional[Application]:
    """Create and configure the Telegram bot Application."""
    global _bot_app

    if not settings.TELEGRAM_BOT_TOKEN:
        logger.warning("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled")
        return None

    _bot_app = Application.builder().token(settings.TELEGRAM_BOT_TOKEN).build()
    _bot_app.add_handler(CommandHandler("start", _start_handler))
    return _bot_app


async def start_bot():
    """Start the bot's polling in a background task."""
    app = create_bot_app()
    if not app:
        return

    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)
    logger.info("Telegram bot started polling")


def stop_bot():
    """Stop the bot gracefully."""
    global _bot_app
    if _bot_app:
        asyncio.create_task(_shutdown_bot(_bot_app))


async def _shutdown_bot(app: Application):
    try:
        await app.updater.stop()
        await app.stop()
        await app.shutdown()
        logger.info("Telegram bot stopped")
    except Exception as e:
        logger.error("Error stopping Telegram bot: %s", e)
