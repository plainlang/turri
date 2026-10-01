1. if a spec diff has at least one functional spec change (create, patch or delete), then unit testing is relevant
2. if a spec diff has no functional spec change (create, patch or delete), then unit testing is not relevant

unit testing encompases: 
- writing unit tests
- making sure they pass
- having a reviewer over them

if unit tests are not relevant (as in 1. ) then we need to only make sure that the coding model isnt cheating. 
- unit tests must pass (if they exist)
- a reviewer needs to be only concerned about the fact the no unit tests have been removed unjustly 

we need 2 prompts for these 2 reviewer cases. 
we need 2 implement this prompts (one that says explicilty to implement tests, and one that says explsitily dont)
we need also another render prompt for when a fresh codebase is getting started. there is no current codebase. 

---

conformance is like an implementation but from the other direction. it is like code but only with the additional constraints that are in test reqs.
- they are focused only on functionalities (other changes cannot be conformance tested)
- conformance tests need code to be tested against
- it doesnt care how the code does something as long at the output is okay (by definition a black box)

they would need their status own tracking - turri.json and turri notes. because someone might only want to conformance tests part of the specs and not everything. 

---

************

"""
- Conformance is its own track. It is black-box, covers functional specs only, and needs code to run against. It has its own record of what it was built from (its own .turri.json and notes), so you can conformance-test only part of the spec.
"""

here when i said conformance needs code to run. a better way to say it would be conformance needs functionality to be ran against. how that functionaltiy is gathered might as well be the same as we group functionalities today.

Q1: c
Q2: can stop a running agent (it might be implementing something right now that will need to be deleted later)
Q3: yes
Q4: same as described above. """how that functionaltiy is gathered might as well be the same as we group functionalities today.""" but it needs to anchored on functionality
Q5: yes fully separate. 
Q6: b) 
Q7: b) 

************

Q8: i gave a reason. if it possible to determine this deterministically all the better, we dont need ai for this

Q9: a), remove the master

Q10: Yes

Q11: Yes. However regenerate should be usable just to regenerate a certain functionality even if it hasnt changed. Maybe the render functionality is not needed anymore actually. 

Q12: a)

Q13: a) 

PS. 

we can conformance test this spec diff (but this spec diff is dependant only on the fact the its functionality lives in the code). so the state of the conformance tests is always a substate of the code. 

plain_modules/<m>/tests/.turri.json is a substate of plain_modules/<m>/code/.turri.json (excluding the test reqs)

and the prompts in the render_* tools dont need test reqs in their prompt. they are not relevant. and the state doesnt need them either (plain_modules/<m>/code/.turri.json). however plain_modules/<m>/tests/.turri.json does need them. 

a change in test reqs should should imply a conformance spec diff. if it is only a change in test reqs, then no new tests need to be written, only existing ones need to be mechanically changed. everything still needs to pass.

************

Q14: a) but conformance tests are carried over respecting the requires rules (same how code is carried over / inherited)

Q15: a) 

Q16: Yes. And these prompts need to be clear, what to do in what scenario. if a definiton of a impl reqs changes for conformance, only mechanical path needs to be chosen 

Q17: a)

Q18: i am only playing with this, we can totally delete all the projects that i have now

Q19: a) 

************

Q20: a) but this should receive its own prompt stating that this is a change and that code and tests need to change. it shouldnt treat it as implemetning the functionality from scratch 

Q21: Yes. Inherited tests should always be ran. That is partially how we make sure we dont break functionality from previous modules

Q22: Yes. 

Q23: Yes.

Q24: a)

************

Q25: 

fresh- what it tells the agent: "testing scripts" is misleading because it implies unit and conformance testing scripts. 

conformance tests should get a "fresh" prompt as well. since it needs some effort to initially setup the "tests" folder since it is merged with "code" folder. but "fresh"

************

Q26: b) 

Q27: Yes. Keep in mind that fixes can pile on top of on another. if a fix doesnt work, it should be reverted, it should be worked out. 

************

Q28: b)
