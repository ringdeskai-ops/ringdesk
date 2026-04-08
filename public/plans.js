(function() {
  fetch('/api/pricing-plans')
    .then(r => r.json())
    .then(function(plans) {
      if (!plans || !plans.length) return;
      var callEls = document.querySelectorAll('.plan-calls');
      var priceEls = document.querySelectorAll('.price-val');
      var planOrder = ['essential','starter','professional','business'];
      planOrder.forEach(function(id, i) {
        var plan = plans.find(function(p) { return p.id === id; });
        if (!plan) return;
        // Update call limits
        if (callEls[i]) {
          var sub = callEls[i].querySelector('div');
          var limit = plan.call_limit >= 1000 ? plan.call_limit.toLocaleString() : plan.call_limit;
          callEls[i].childNodes[0].textContent = limit + ' calls per month';
        }
        // Update prices
        if (priceEls[i]) {
          priceEls[i].textContent = plan.price_monthly;
          priceEls[i].setAttribute('data-monthly', plan.price_monthly);
          priceEls[i].setAttribute('data-annual', plan.price_annual);
        }
      });
    }).catch(function() {});
})();
