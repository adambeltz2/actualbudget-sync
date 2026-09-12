// Pure scoring logic for the "Financial Health Check" widget — no
// @actual-app/api dependency, so this is unit-testable without a live
// server. Deliberately rule-based rather than generated text: every
// recommendation traces back to a threshold check here, not a language
// model's judgment call about someone's finances.

function statusFromRatio(ratio) {
  if (ratio >= 1) return 'good';
  if (ratio >= 0.5) return 'watch';
  return 'action';
}

// Months of expenses a liquid-savings balance would cover. Uses total
// average spend as a stand-in for "essential" expenses — a true
// essential-only figure would need category-level tagging Actual doesn't
// give us for free.
function computeEmergencyFund({ liquidBalance, monthlyAvgSpend, targetMonths }) {
  const months = monthlyAvgSpend > 0 ? liquidBalance / monthlyAvgSpend : 0;
  const ratio = targetMonths > 0 ? months / targetMonths : (months > 0 ? 1 : 0);
  return {
    months,
    targetMonths,
    pctOfTarget: Math.min(ratio * 100, 100),
    status: statusFromRatio(ratio)
  };
}

// Savings rate uses a 0%..target scale rather than target-relative ratio,
// since a negative rate (spending more than earned) is meaningfully worse
// than "half of target" and should read as 'action', not 'watch'.
function computeSavingsRate({ income, spend, targetPct }) {
  const ratePct = income > 0 ? ((income - spend) / income) * 100 : 0;
  const status = ratePct >= targetPct ? 'good' : (ratePct >= 0 ? 'watch' : 'action');
  return {
    ratePct,
    targetPct,
    pctOfTarget: targetPct > 0 ? Math.min(Math.max((ratePct / targetPct) * 100, 0), 100) : (ratePct >= 0 ? 100 : 0),
    status
  };
}

// Debt load is measured in months of income rather than a formal
// debt-to-income ratio, because Actual only gives us account balances, not
// monthly payment amounts — a real DTI ratio needs the latter.
function computeDebtLoad({ debtTotal, monthlyIncome }) {
  const monthsOfIncome = monthlyIncome > 0 ? debtTotal / monthlyIncome : 0;
  const status = debtTotal === 0 ? 'good' : (monthsOfIncome < 1 ? 'watch' : 'action');
  return { debtTotal, monthsOfIncome, status };
}

// Weighted overall score: emergency fund and savings rate carry equal,
// larger weight since they reflect ongoing financial resilience; debt load
// carries less weight because it's the least precise of the three (balance,
// not payment, based).
function computeOverallScore({ emergencyFund, savingsRate, debtLoad }) {
  const efScore = emergencyFund.pctOfTarget;
  const srScore = savingsRate.pctOfTarget;
  const dlScore = Math.max(100 - debtLoad.monthsOfIncome * 50, 0);
  const overall = Math.round(efScore * 0.4 + srScore * 0.4 + dlScore * 0.2);
  const label = overall >= 80 ? 'Strong' : overall >= 60 ? 'Good' : overall >= 40 ? 'Fair' : 'Needs Attention';
  return { overall, label };
}

function buildRecommendations({ emergencyFund, savingsRate, debtLoad }) {
  const recs = [];
  if (emergencyFund.status !== 'good') {
    recs.push({
      status: emergencyFund.status,
      message: `Your emergency fund covers ${emergencyFund.months.toFixed(1)} months of spending, below your ${emergencyFund.targetMonths}-month target. Consider prioritizing this before other savings goals.`
    });
  }
  if (savingsRate.status !== 'good') {
    recs.push({
      status: savingsRate.status,
      message: `You're saving ${savingsRate.ratePct.toFixed(0)}% of income, below your ${savingsRate.targetPct}% target. Check Spend by Category for the biggest place to cut back.`
    });
  }
  if (debtLoad.debtTotal > 0) {
    recs.push({
      status: debtLoad.status,
      message: `You're carrying $${Math.round(debtLoad.debtTotal).toLocaleString('en-US')} in debt — about ${debtLoad.monthsOfIncome.toFixed(1)} months of income. Paying this down reduces interest costs directly.`
    });
  }
  if (recs.length === 0) {
    recs.push({ status: 'good', message: 'All three checks look healthy — nothing urgent to flag.' });
  }
  return recs;
}

// Splits net worth into liquid / investment / debt for the Net Worth
// Breakdown display. Investment accounts are also manually tagged (same
// reasoning as emergency fund accounts — Actual has no account-type field),
// so "liquid" here is simply whatever's left once investment and debt are
// accounted for: liquid + investment - debt = netWorth.
function computeNetWorthBreakdown({ netWorth, investmentBalance, debtTotal }) {
  const investment = Math.max(investmentBalance, 0);
  const liquid = Math.max(netWorth - investment + debtTotal, 0);
  return { liquid, investment, debt: debtTotal, netWorth };
}

module.exports = {
  computeEmergencyFund, computeSavingsRate, computeDebtLoad,
  computeOverallScore, buildRecommendations, computeNetWorthBreakdown
};
