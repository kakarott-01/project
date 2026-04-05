PUBLIC_STRATEGY_CATALOG = [
    {
        "strategy_key": "TREND_RIDER_V1",
        "name": "TREND_RIDER_V1",
        "description": "Captures sustained directional moves and avoids low-conviction chop.",
        "risk_level": "MEDIUM",
        "supported_markets": ["CRYPTO", "STOCKS", "FOREX"],
        "supported_timeframes": ["5m", "15m", "1h"],
        "historical_performance": {
            "win_rate": 58.4,
            "average_return": 12.63,
            "max_drawdown": 8.91,
            "sharpe_ratio": 1.41,
        },
    },
    {
        "strategy_key": "MEAN_REVERSION_PRO",
        "name": "MEAN_REVERSION_PRO",
        "description": "Looks for stretched moves that statistically tend to normalize over short horizons.",
        "risk_level": "LOW",
        "supported_markets": ["CRYPTO", "STOCKS"],
        "supported_timeframes": ["5m", "15m", "30m"],
        "historical_performance": {
            "win_rate": 63.2,
            "average_return": 9.84,
            "max_drawdown": 6.27,
            "sharpe_ratio": 1.58,
        },
    },
    {
        "strategy_key": "BREAKOUT_PULSE_X",
        "name": "BREAKOUT_PULSE_X",
        "description": "Prioritizes momentum expansion after compression and confirmed participation.",
        "risk_level": "HIGH",
        "supported_markets": ["CRYPTO", "FOREX", "STOCKS"],
        "supported_timeframes": ["15m", "1h", "4h"],
        "historical_performance": {
            "win_rate": 51.7,
            "average_return": 15.94,
            "max_drawdown": 12.35,
            "sharpe_ratio": 1.29,
        },
    },
]


def platform_market_to_public_market(market_type: str) -> str:
    if market_type == "crypto":
        return "CRYPTO"
    if market_type == "commodities":
        return "FOREX"
    return "STOCKS"
