export const conditionDescriptions = {
 Game:{"New in Shrink":"Original seal intact; unopened","Like New":"Pieces unpunched and cards wrapped; never played","Very Good":"Pieces punched and sorted; little or no wear","Good":"Played and maintained; box or books show wear","Fair":"Noticeable wear and minor damage","Poor":"Worn but playable; significant box or book damage"},
 Puzzle:{"New in Shrink":"Factory sealed","Like New":"All pieces; never assembled; original box","Very Good":"All pieces; little or no wear","Good":"All pieces; box shows use","Fair":"All pieces; minor box damage","Poor":"All pieces but no box"},
 RC:{"New in Shrink":"Factory sealed","Like New":"Complete, undamaged, original box","Very Good":"Complete; barely used","Good":"Working with limited damage","Fair":"Heavily used, functional, cosmetic damage","Poor":"Usable; missing or damaged parts","Scrap / Parts":"Incomplete or non-running; for parts"},
 Train:{"New in Shrink":"Factory sealed","Like New":"Complete, never assembled","Very Good":"Complete, little or no use","Good":"Run on layout, otherwise good condition","Fair":"Heavily run but functional; cosmetic damage","Poor":"Worn but usable; missing parts","Scrap / Parts":"Non-running or incomplete; for parts"},
 Other:{"New in Shrink":"Factory sealed","Like New":"Virtually unused","Very Good":"Light use","Good":"Normal use","Fair":"Noticeable wear","Poor":"Heavy wear","Scrap / Parts":"For parts"}
};
export const conditionsFor = type => conditionDescriptions[type] || conditionDescriptions.Other;
