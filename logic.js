;(() => {
	const shuffle = items => {
		const nextItems = [...items]

		for (let index = nextItems.length - 1; index > 0; index -= 1) {
			const swapIndex = Math.floor(Math.random() * (index + 1))
			;[nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]]
		}

		return nextItems
	}

	const buildDeck = ({ cardTypes, heatValues }) => {
		let cardId = 1
		const deck = []
		const shuffledHeatValues = shuffle(heatValues)

		cardTypes.forEach(type => {
			for (let rank = 1; rank <= type.count; rank += 1) {
				deck.push({
					id: cardId,
					rank,
					type,
					heat: shuffledHeatValues[cardId - 1]
				})
				cardId += 1
			}
		})

		return shuffle(deck)
	}

	const highestRankInHand = ({ hand, typeKey }) => {
		let highestRank = 0

		hand.forEach(card => {
			if (card.type.key === typeKey) {
				highestRank = Math.max(highestRank, card.rank)
			}
		})

		return highestRank
	}

	const marketValueForCard = card => card.type.marketValue * card.rank

	const sellValueForCard = ({ card, sellPhaseRanks }) => card.type.marketValue * (sellPhaseRanks.get(card.type.key) || 0)

	const creditUpgradeProfitThreshold = roundStartCredit => roundStartCredit * 0.2

	const roundToNearestHundred = value => Math.round(value / 100) * 100

	const buyPriceForCard = card => {
		if (card.type.count <= 1 || card.rank >= card.type.count) {
			return card.type.price
		}

		const minPrice = card.type.price * 0.5
		const rankProgress = (card.rank - 1) / (card.type.count - 1)
		const rawPrice = minPrice + (card.type.price - minPrice) * rankProgress

		return roundToNearestHundred(rawPrice)
	}

	const creditDeltaForProfit = ({ profit, roundStartCredit }) => {
		if (profit >= creditUpgradeProfitThreshold(roundStartCredit)) {
			return 5000
		}

		if (profit < 0) {
			return -1000
		}

		return 0
	}

	const performanceLabel = ({ profit, roundStartCredit }) => {
		if (profit >= creditUpgradeProfitThreshold(roundStartCredit)) {
			return 'You made a very impressive profit.'
		}

		if (profit >= roundStartCredit * 0.1) {
			return 'You made a solid profit.'
		}

		if (profit >= 0) {
			return "You're just barely making a profit."
		}

		return 'You lost money this week.'
	}

	window.FENCE_LOGIC = {
		buildDeck,
		highestRankInHand,
		marketValueForCard,
		sellValueForCard,
		creditUpgradeProfitThreshold,
		buyPriceForCard,
		creditDeltaForProfit,
		performanceLabel
	}
})()